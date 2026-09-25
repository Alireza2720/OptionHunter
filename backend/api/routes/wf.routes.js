'use strict';
// ============================================================
// wf.routes.js — endpoints فاز ۵
// ============================================================

function register(app, deps) {
    const { wfService } = deps;

    if (!wfService) {
        console.warn('wf.routes: wfService not provided — skipping');
        return;
    }

    app.get('/api/wf/pair/:jobId/:symbol/:strategyId', async (req, res, next) => {
        try {
            const r = await wfService.runOnePair(
                req.params.jobId,
                decodeURIComponent(req.params.symbol),
                req.params.strategyId,
                {
                    numWindows: +(req.query.windows || 4),
                    minTrades: +(req.query.minTrades || 5),
                    numTrials: +(req.query.numTrials || 234)
                }
            );
            res.json(r);
        } catch (e) {
            if (e.status) return res.status(e.status).json({ error: e.message });
            next(e);
        }
    });

    app.post('/api/wf/run/:jobId', async (req, res, next) => {
        try {
            const opts = req.body || {};
            const r = await wfService.runWhitelist(req.params.jobId, {
                numWindows: opts.windows || 4,
                minTrades: opts.minTrades || 5,
                numTrials: opts.numTrials || 234
            });
            res.json(r);
        } catch (e) { next(e); }
    });

    // 🆕 Aggregate walk-forward — همه‌ی tradeهای whitelist در پنجره‌های زمانی
    app.post('/api/wf/aggregate/:jobId', async (req, res, next) => {
        try {
            const opts = req.body || {};
            const r = await wfService.runAggregate(req.params.jobId, {
                numWindows: opts.windows || 4,
                minTrades: opts.minTrades || 5,
                numTrials: opts.numTrials || 234
            });

            // 🆕 ذخیره‌ی WF whitelist
            if (!r.error && r.perStrategy) {
                try {
                    const saved = await wfService.saveWfStrategyWhitelist(req.params.jobId, r);
                    r.wfWhitelistSaved = saved;
                } catch (saveErr) {
                    deps.logger && deps.logger.warn('save wf whitelist: ' + saveErr.message);
                }
            }

            res.json(r);
        } catch (e) { next(e); }
    });
}

module.exports = { register };