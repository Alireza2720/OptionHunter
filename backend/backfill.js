'use strict';
// ======================== backfill.js — TSETMC Intraday Backfill ========================
// مدیریت صف دریافت دیتای ۱ دقیقه‌ای تاریخی
// - هر نماد یه Job مستقل
// - روزهای معاملاتی از candles_daily خونده می‌شه
// - Cron هر ۲۰ دقیقه ۴ روز از Job فعال می‌گیره
// - پیشرفت ذخیره می‌شه، هر روز independent

const Tsetmc = require('./tsetmc.js');

let deps = null;
function init(d) { deps = d; }

const DEFAULTS = {
  cronMinutes: 20,
  batchSize: 4,
  delayBetweenRequests: 5,
  lookbackMonths: 6,
  autoStartNew: true,
  maxAttemptsPerDay: 10
};

async function getSettings() {
  const db = deps.getDB();
  const doc = await db.collection('meta').findOne({ _id: 'backfill_settings' });
  return { ...DEFAULTS, ...((doc && doc.values) || {}) };
}

async function saveSettings(values) {
  const db = deps.getDB();
  const current = await getSettings();
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (values[k] === undefined || values[k] === null || values[k] === '') continue;
    if (k === 'autoStartNew') clean[k] = !!values[k];
    else {
      const n = parseFloat(values[k]);
      if (Number.isFinite(n) && n > 0) clean[k] = n;
    }
  }
  const merged = { ...current, ...clean };
  await db.collection('meta').updateOne({ _id: 'backfill_settings' }, { $set: { values: merged } }, { upsert: true });
  return merged;
}

function toGregorianInt(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

async function resolveInsCode(symbol) {
  const list = await Tsetmc.searchInstrument(symbol);
  if (!list || !list.length) throw new Error('نماد ' + symbol + ' پیدا نشد');
  const found = list.find(x => x.lVal18AFC === symbol) || list[0];
  return { insCode: String(found.insCode), name: found.lVal30 || symbol };
}

async function getTradingDays(symbol, months) {
  const db = deps.getDB();
  const startDate = new Date();
  startDate.setUTCMonth(startDate.getUTCMonth() - months);
  const rows = await db.collection('candles_daily')
    .find({ symbol, time: { $gte: startDate } })
    .sort({ time: 1 })
    .project({ time: 1 })
    .toArray();
  return rows.map(r => toGregorianInt(r.time));
}

// ---------- ایجاد Job برای یک سهام ----------
async function createStockJob(symbol, options = {}) {
  const db = deps.getDB();
  const settings = await getSettings();
  const months = options.months || settings.lookbackMonths;

  const existing = await db.collection('tsetmc_backfill').findOne({
    type: 'stock', symbol, status: { $in: ['PENDING', 'IN_PROGRESS', 'PAUSED'] }
  });
  if (existing) return { existing: true, job: existing };

  const { insCode, name } = await resolveInsCode(symbol);
  const days = await getTradingDays(symbol, months);
  if (!days.length) throw new Error('روز معاملاتی یافت نشد — ابتدا «تاریخچه روزانه» را دانلود کنید');

  const job = {
    type: 'stock',
    symbol,
    name,
    insCode,
    underlying: symbol,
    status: 'PENDING',
    priority: options.priority !== undefined ? options.priority : 10,
    lookbackMonths: months,
    startDate: days[0],
    endDate: days[days.length - 1],
    cursor: 0,
    days: days.map(d => ({ date: d, status: 'PENDING', candles: 0, attempts: 0, error: null, fetchedAt: null })),
    stats: { total: days.length, done: 0, failed: 0, pending: days.length, noTrades: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null
  };
  const r = await db.collection('tsetmc_backfill').insertOne(job);
  return { job: { _id: r.insertedId, ...job } };
}

// ---------- ایجاد Job برای همه قراردادهای فعال یک نماد پایه ----------
async function createOptionJobs(underlying, options = {}) {
  const db = deps.getDB();
  const settings = await getSettings();
  const months = options.months || settings.lookbackMonths;

  const { insCode: uInsCode } = await resolveInsCode(underlying);
  const baseDays = await getTradingDays(underlying, months);
  if (!baseDays.length) throw new Error('روز معاملاتی پایه یافت نشد');

  const watch = await Tsetmc.getOptionMarketWatch();
  const relevant = watch.filter(x => String(x.underlyingInsCode) === String(uInsCode));

  const created = [];
  let skipped = 0;

  for (const c of relevant) {
    const contracts = [];
    if (c.insCodeCall && c.symbolCall) contracts.push({ insCode: c.insCodeCall, symbol: c.symbolCall, type: 'call', strike: c.strike });
    if (c.insCodePut && c.symbolPut) contracts.push({ insCode: c.insCodePut, symbol: c.symbolPut, type: 'put', strike: c.strike });

    for (const ct of contracts) {
      const existing = await db.collection('tsetmc_backfill').findOne({
        insCode: String(ct.insCode), status: { $in: ['PENDING', 'IN_PROGRESS', 'PAUSED', 'DONE'] }
      });
      if (existing) { skipped++; continue; }

      const job = {
        type: 'option',
        symbol: ct.symbol,
        name: c.nameCall || ct.symbol,
        insCode: String(ct.insCode),
        underlying,
        underlyingInsCode: String(uInsCode),
        optionType: ct.type,
        strike: ct.strike,
        expiry: c.expiry,
        status: 'PENDING',
        priority: options.priority !== undefined ? options.priority : 3,
        lookbackMonths: months,
        startDate: baseDays[0],
        endDate: baseDays[baseDays.length - 1],
        cursor: 0,
        days: baseDays.map(d => ({ date: d, status: 'PENDING', candles: 0, attempts: 0, error: null, fetchedAt: null })),
        stats: { total: baseDays.length, done: 0, failed: 0, pending: baseDays.length, noTrades: 0 },
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        finishedAt: null
      };
      const r = await db.collection('tsetmc_backfill').insertOne(job);
      created.push({ _id: r.insertedId, symbol: ct.symbol, insCode: ct.insCode });
    }
  }

  return { created: created.length, skipped, jobs: created };
}

// ---------- پردازش یک روز ----------
async function processDay(job, dayInfo) {
  const db = deps.getDB();
  try {
    const trades = await Tsetmc.getTradeHistory(job.insCode, dayInfo.date, 3);
    if (!trades || !trades.length) {
      return { status: 'NO_TRADES', candles: 0 };
    }
    const candles = Tsetmc.aggregateTo1m(trades, dayInfo.date);
    if (!candles.length) {
      return { status: 'NO_TRADES', candles: 0 };
    }
    let saved = 0;
    for (const c of candles) {
      await db.collection('candles_base').updateOne(
        { symbol: job.symbol, time: c.time },
        {
          $set: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, trades: c.trades, source: 'tsetmc-backfill', backfilledAt: new Date() },
          $setOnInsert: { symbol: job.symbol, time: c.time }
        },
        { upsert: true }
      );
      saved++;
    }
    return { status: 'DONE', candles: saved };
  } catch (e) {
    return { status: 'FAILED', error: e.message };
  }
}

// ---------- اجرای یک tick (از cron) ----------
let tickRunning = false;
async function runBackfillTick(force) {
  if (tickRunning) return { busy: true };
  tickRunning = true;
  try {
    const db = deps.getDB();
    const settings = await getSettings();

    // Job فعال یا اولین PENDING با بالاترین priority
    let job = await db.collection('tsetmc_backfill').findOne({ status: 'IN_PROGRESS' });
    if (!job) {
      job = await db.collection('tsetmc_backfill').findOne(
        { status: 'PENDING' },
        { sort: { priority: -1, createdAt: 1 } }
      );
      if (!job) return { idle: true };
      await db.collection('tsetmc_backfill').updateOne(
        { _id: job._id },
        { $set: { status: 'IN_PROGRESS', startedAt: new Date() } }
      );
      job.status = 'IN_PROGRESS';
    }

    const batchSize = settings.batchSize;
    const results = [];

    for (let i = 0; i < batchSize; i++) {
      // پیدا کردن روز بعدی PENDING از cursor
      let dayIdx = -1;
      for (let k = job.cursor; k < job.days.length; k++) {
        if (job.days[k].status === 'PENDING') { dayIdx = k; break; }
      }
      // اگه از cursor به بعد نبود، از ابتدا بگرد
      if (dayIdx === -1) {
        for (let k = 0; k < job.days.length; k++) {
          if (job.days[k].status === 'PENDING') { dayIdx = k; break; }
        }
      }
      if (dayIdx === -1) break;

      const dayInfo = job.days[dayIdx];
      const r = await processDay(job, dayInfo);

      const setFields = {};
      setFields['days.' + dayIdx + '.status'] = r.status;
      setFields['days.' + dayIdx + '.candles'] = r.candles || 0;
      setFields['days.' + dayIdx + '.attempts'] = (dayInfo.attempts || 0) + 1;
      setFields['days.' + dayIdx + '.error'] = r.error || null;
      setFields['days.' + dayIdx + '.fetchedAt'] = new Date();
      await db.collection('tsetmc_backfill').updateOne({ _id: job._id }, { $set: setFields });

      job.days[dayIdx].status = r.status;
      results.push({ date: dayInfo.date, ...r });

      if (i < batchSize - 1) {
        await new Promise(resolve => setTimeout(resolve, settings.delayBetweenRequests * 1000));
      }
    }

    // محاسبه آمار جدید
    const stats = { total: job.days.length, done: 0, failed: 0, pending: 0, noTrades: 0 };
    for (const d of job.days) {
      if (d.status === 'DONE') stats.done++;
      else if (d.status === 'FAILED') stats.failed++;
      else if (d.status === 'NO_TRADES') { stats.noTrades++; stats.done++; }
      else stats.pending++;
    }

    // آپدیت cursor
    let newCursor = job.days.length;
    for (let k = 0; k < job.days.length; k++) {
      if (job.days[k].status === 'PENDING') { newCursor = k; break; }
    }

    const allDone = stats.pending === 0;
    await db.collection('tsetmc_backfill').updateOne({ _id: job._id }, {
      $set: {
        cursor: newCursor,
        stats,
        status: allDone ? 'DONE' : 'IN_PROGRESS',
        updatedAt: new Date(),
        finishedAt: allDone ? new Date() : null,
        lastBatch: { at: new Date(), count: results.length, results: results.slice(0, 4) }
      }
    });

    return { jobId: String(job._id), symbol: job.symbol, type: job.type, batch: results.length, stats, done: allDone };
  } finally {
    tickRunning = false;
  }
}

// ---------- عملیات دستی ----------
async function listJobs(filter = {}) {
  const db = deps.getDB();
  const q = {};
  if (filter.type) q.type = filter.type;
  if (filter.status) q.status = filter.status;
  return db.collection('tsetmc_backfill').find(q).sort({ priority: -1, createdAt: 1 }).toArray();
}

async function getJob(id, ObjectId) {
  const db = deps.getDB();
  return db.collection('tsetmc_backfill').findOne({ _id: new ObjectId(id) });
}

async function pauseJob(id, ObjectId) {
  const db = deps.getDB();
  await db.collection('tsetmc_backfill').updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'PAUSED', updatedAt: new Date() } }
  );
}

async function resumeJob(id, ObjectId) {
  const db = deps.getDB();
  await db.collection('tsetmc_backfill').updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'PENDING', updatedAt: new Date() } }
  );
}

async function resetJob(id, ObjectId) {
  const db = deps.getDB();
  const job = await db.collection('tsetmc_backfill').findOne({ _id: new ObjectId(id) });
  if (!job) throw new Error('Job یافت نشد');
  const newDays = job.days.map(d => ({ date: d.date, status: 'PENDING', candles: 0, attempts: 0, error: null, fetchedAt: null }));
  await db.collection('tsetmc_backfill').updateOne(
    { _id: job._id },
    { $set: { days: newDays, cursor: 0, stats: { total: newDays.length, done: 0, failed: 0, pending: newDays.length, noTrades: 0 }, status: 'PENDING', updatedAt: new Date(), startedAt: null, finishedAt: null } }
  );
}

async function deleteJob(id, ObjectId) {
  const db = deps.getDB();
  await db.collection('tsetmc_backfill').deleteOne({ _id: new ObjectId(id) });
}

async function setPriority(id, priority, ObjectId) {
  const db = deps.getDB();
  await db.collection('tsetmc_backfill').updateOne(
    { _id: new ObjectId(id) },
    { $set: { priority, updatedAt: new Date() } }
  );
}

// اجرای فوری یه Job خاص (مستقل از cron)
async function runJobNow(id, ObjectId) {
  const db = deps.getDB();
  const job = await db.collection('tsetmc_backfill').findOne({ _id: new ObjectId(id) });
  if (!job) throw new Error('Job یافت نشد');

  const settings = await getSettings();
  const batchSize = settings.batchSize;

  // اگه status DONE بود، خطا
  if (job.status === 'DONE') throw new Error('این Job قبلاً تکمیل شده');

  // اگه PAUSED بود، موقتاً به IN_PROGRESS تغییر بده (فقط برای این batch)
  const originalStatus = job.status;
  if (job.status === 'PAUSED' || job.status === 'PENDING') {
    await db.collection('tsetmc_backfill').updateOne(
      { _id: job._id },
      { $set: { status: 'IN_PROGRESS', startedAt: job.startedAt || new Date() } }
    );
    job.status = 'IN_PROGRESS';
  }

  const results = [];

  for (let i = 0; i < batchSize; i++) {
    let dayIdx = -1;
    for (let k = job.cursor; k < job.days.length; k++) {
      if (job.days[k].status === 'PENDING') { dayIdx = k; break; }
    }
    if (dayIdx === -1) {
      for (let k = 0; k < job.days.length; k++) {
        if (job.days[k].status === 'PENDING') { dayIdx = k; break; }
      }
    }
    if (dayIdx === -1) break;

    const dayInfo = job.days[dayIdx];
    const r = await processDay(job, dayInfo);

    const setFields = {};
    setFields['days.' + dayIdx + '.status'] = r.status;
    setFields['days.' + dayIdx + '.candles'] = r.candles || 0;
    setFields['days.' + dayIdx + '.attempts'] = (dayInfo.attempts || 0) + 1;
    setFields['days.' + dayIdx + '.error'] = r.error || null;
    setFields['days.' + dayIdx + '.fetchedAt'] = new Date();
    await db.collection('tsetmc_backfill').updateOne({ _id: job._id }, { $set: setFields });

    job.days[dayIdx].status = r.status;
    results.push({ date: dayInfo.date, ...r });

    if (i < batchSize - 1) {
      await new Promise(resolve => setTimeout(resolve, settings.delayBetweenRequests * 1000));
    }
  }

  // آمار
  const stats = { total: job.days.length, done: 0, failed: 0, pending: 0, noTrades: 0 };
  for (const d of job.days) {
    if (d.status === 'DONE') stats.done++;
    else if (d.status === 'FAILED') stats.failed++;
    else if (d.status === 'NO_TRADES') { stats.noTrades++; stats.done++; }
    else stats.pending++;
  }

  let newCursor = job.days.length;
  for (let k = 0; k < job.days.length; k++) {
    if (job.days[k].status === 'PENDING') { newCursor = k; break; }
  }

  const allDone = stats.pending === 0;
  // اگه PAUSED بود و کارش تموم نشده، به PAUSED برگردون
  const finalStatus = allDone ? 'DONE' : (originalStatus === 'PAUSED' ? 'PAUSED' : 'IN_PROGRESS');

  await db.collection('tsetmc_backfill').updateOne({ _id: job._id }, {
    $set: {
      cursor: newCursor,
      stats,
      status: finalStatus,
      updatedAt: new Date(),
      finishedAt: allDone ? new Date() : null,
      lastBatch: { at: new Date(), count: results.length, results: results.slice(0, 4), manual: true }
    }
  });

  return {
    jobId: String(job._id),
    symbol: job.symbol,
    type: job.type,
    batch: results.length,
    stats,
    done: allDone,
    results
  };
}
// لاگ تلاش‌ها (برای نمایش در UI)
async function getDayLogs(symbol, limit = 100) {
  const db = deps.getDB();
  return db.collection('tsetmc_fetch_log').find({ symbol }).sort({ createdAt: -1 }).limit(limit).toArray();
}

module.exports = {
  init,
  getSettings, saveSettings,
  createStockJob, createOptionJobs,
  runBackfillTick,
  listJobs, getJob,
  pauseJob, resumeJob, resetJob, deleteJob, setPriority, runJobNow,
  getDayLogs
};