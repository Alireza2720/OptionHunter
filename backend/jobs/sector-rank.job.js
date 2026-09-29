'use strict';
// ============================================================
// sector-rank.job.js — محاسبه‌ی رتبه‌ی صنایع
// ============================================================
// هر ۱۵ دقیقه در ساعات بازار + یک بار در استارتاپ

const cron = require('node-cron');

let deps = { getDB: null, dataService: null, logger: null };
function init(d) { deps = { ...deps, ...d }; }

const LOOKBACK_BARS = 20;

const marketHours = require('../infra/market-hours');

async function compute() {
    // 🆕 تو ساعات بازار اجرا نشه
    if (marketHours.isMarketHourOrNear()) {
        deps.logger && deps.logger.info('sector-rank: skipped (market open)');
        return [];
    }
    try {
        const db = deps.getDB();
        const { COLLECTIONS } = require('../config/constants');
        const { getSector, getAllSectors } = require('../core/sectors');

        const monitored = await db.collection(COLLECTIONS.MONITORED_SYMBOLS)
            .find({ enabled: true }).toArray();

        const sectorReturns = {};   // sector → array of returns
        const symInfo = {};

        for (const m of monitored) {
            try {
                const candles = await deps.dataService.getCandles(m.symbol, '1d');
                if (!candles || candles.length < LOOKBACK_BARS + 2) continue;
                const last = candles[candles.length - 1].close;
                const past = candles[candles.length - 1 - LOOKBACK_BARS].close;
                if (!(last > 0) || !(past > 0)) continue;
                const ret = (last / past - 1) * 100;
                const sec = getSector(m.symbol);
                if (!sectorReturns[sec]) sectorReturns[sec] = [];
                sectorReturns[sec].push(ret);
                symInfo[m.symbol] = { sector: sec, return20d: Math.round(ret*100)/100 };
            } catch (e) {
                deps.logger && deps.logger.warn(`sector-rank ${m.symbol}: ${e.message}`);
            }
        }

        // میانگین هر صنعت
        const sectorAvg = {};
        for (const [sec, rets] of Object.entries(sectorReturns)) {
            sectorAvg[sec] = rets.reduce((s,x)=>s+x,0) / rets.length;
        }

        // رتبه‌بندی: بالاترین میانگین = رتبه ۱
        const ranked = Object.entries(sectorAvg)
            .sort(([,a], [,b]) => b - a)
            .map(([sector, avgRet], idx) => ({
                rank: idx + 1,
                sector,
                avgReturn20d: Math.round(avgRet * 100) / 100,
                memberCount: sectorReturns[sector].length
            }));

        await db.collection(COLLECTIONS.META).updateOne(
            { _id: 'sector_ranking' },
            { $set: {
                ranked,
                symbols: symInfo,
                computedAt: new Date(),
                totalSectors: ranked.length,
                totalSymbols: Object.keys(symInfo).length
            }},
            { upsert: true }
        );

        deps.logger && deps.logger.info(
            `sector ranking: ${ranked.length} sectors, top=${ranked[0] ? ranked[0].sector : '-'}`
        );
        return ranked;
    } catch (e) {
        deps.logger && deps.logger.error('sector ranking: ' + e.message);
        return [];
    }
}

let task = null;
function start() {
    if (task) return;
    // 🆕 فقط بعد از بازار: ۱۲:۴۰ و ۱۳:۳۰ و ۱۴:۳۰
    task = cron.schedule('40 12,13,14 * * 6,0,1,2,3', compute, { timezone: 'Asia/Tehran' });
    deps.logger && deps.logger.info('sector-rank.job started (post-market only)');
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { init, start, stop, compute };