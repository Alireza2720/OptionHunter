'use strict';
// ============================================================
// provenance.service.js — F1: Backtest Provenance Report
// ============================================================
// Records for every backtest run:
//   - git SHA + dirty status
//   - BACKTEST_LOGIC_VERSION + COST_MODEL_VERSION
//   - config hash (symbols, strategies, dates, params)
//   - data snapshot (counts + range for key collections)
//   - result summary (PF, return, DD, sharpe, trades)
// Enables: reproduce a run, diff two runs to see what changed.
// ============================================================

const crypto = require('crypto');
const path = require('path');
const { COLLECTIONS } = require('../config/constants');

const COLLECTION = 'backtest_provenance';

let deps = { getDB: null, logger: null };
let _indexEnsured = false;

function init(d) { deps = { ...deps, ...d }; }

function _stableStringify(o) {
  if (o === null || o === undefined) return 'null';
  if (typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(_stableStringify).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _stableStringify(o[k])).join(',') + '}';
}

function _gitInfo() {
  try {
    const { execSync } = require('child_process');
    const ROOT = path.resolve(__dirname, '..', '..');
    const sha = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).trim();
    let branch = 'unknown', dirty = false, msg = '';
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).trim(); } catch (_) {}
    try { dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).trim().length > 0; } catch (_) {}
    try { msg = execSync('git log -1 --format=%s', { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).trim().slice(0, 100); } catch (_) {}
    return { sha, shortSha: sha.slice(0, 7), branch, dirty, msg };
  } catch (e) {
    return { sha: 'unknown', shortSha: 'unknown', branch: 'unknown', dirty: false, msg: (e.message || '').slice(0, 80) };
  }
}

function _versions() {
  let logic = 'unknown', cost = 'unknown';
  try {
    const b = require('../core/backtest');
    logic = b.BACKTEST_LOGIC_VERSION || 'unknown';
    cost = b.BACKTEST_COST_MODEL_VERSION || 'unknown';
  } catch (_) {}
  return { logic, costModel: cost, node: process.version, platform: process.platform };
}

async function _dataSnapshot(db) {
  const { OPTION_DATA_CUTOFF } = require('../config/constants');
  const snap = {};
  const defs = [
    { name: 'optionHistory', col: COLLECTIONS.OPTION_HISTORY, filter: { time: { $gte: OPTION_DATA_CUTOFF } } },
    { name: 'candlesBase', col: COLLECTIONS.CANDLES_BASE, filter: {} },
    { name: 'candlesDaily', col: COLLECTIONS.CANDLES_DAILY, filter: {} },
    { name: 'optionSnapshots', col: COLLECTIONS.OPTION_SNAPSHOTS, filter: {} },
  ];
  for (const d of defs) {
    try {
      const agg = await db.collection(d.col).aggregate([
        { $match: d.filter },
        { $group: { _id: null, count: { $sum: 1 }, min: { $min: '$time' }, max: { $max: '$time' } } }
      ], { allowDiskUse: true, maxTimeMS: 30000 }).toArray();
      const r = agg[0] || { count: 0, min: null, max: null };
      snap[d.name] = {
        count: r.count,
        from: r.min ? new Date(r.min).toISOString() : null,
        to: r.max ? new Date(r.max).toISOString() : null,
      };
    } catch (e) {
      snap[d.name] = { error: (e.message || '').slice(0, 100) };
    }
  }
  return snap;
}

function _configsHash(cfg) {
  const obj = {
    mode: cfg.mode,
    symbols: [...(cfg.symbols || [])].sort(),
    strategies: [...(cfg.strategies || [])].map(s => typeof s === 'string' ? s : s.id).sort(),
    dateFrom: cfg.dateFrom,
    dateTo: cfg.dateTo,
    optionType: cfg.optionType,
    qualityLevel: cfg.qualityLevel,
    panels: cfg.panels,
  };
  return crypto.createHash('sha256').update(_stableStringify(obj)).digest('hex');
}

async function _ensureIndex() {
  if (_indexEnsured) return;
  _indexEnsured = true;
  try {
    const db = deps.getDB();
    await db.collection(COLLECTION).createIndex({ recordedAt: -1 });
  } catch (_) {}
}

async function record(jobId, job, result) {
  if (!deps.getDB) return null;
  await _ensureIndex();
  try {
    const db = deps.getDB();
    const payload = (job && job.payload) || {};
    const git = _gitInfo();
    const versions = _versions();
    const data = await _dataSnapshot(db);
    const configsHash = _configsHash(payload);
    const doc = {
      _id: String(jobId),
      jobId: String(jobId),
      recordedAt: new Date(),
      git,
      versions,
      configsHash,
      config: {
        mode: payload.mode,
        symbols: payload.symbols,
        strategies: (payload.strategies || []).map(s => typeof s === 'string' ? s : s.id),
        dateFrom: payload.dateFrom,
        dateTo: payload.dateTo,
        optionType: payload.optionType,
        qualityLevel: payload.qualityLevel,
        panels: payload.panels,
      },
      dataSnapshot: data,
      result: result ? {
        pf: (result.portfolio && result.portfolio.stats && result.portfolio.stats.profitFactor) || null,
        totalReturnPct: (result.portfolio && result.portfolio.stats && result.portfolio.stats.totalReturnPct) || null,
        maxDD: (result.portfolio && result.portfolio.stats && result.portfolio.stats.maxDD) || null,
        sharpe: (result.portfolio && result.portfolio.stats && result.portfolio.stats.sharpe) || null,
        detailsCount: (result.details || []).length,
        acceptedTrades: (result.portfolio && result.portfolio.acceptedTrades) || 0,
        totalTrades: (result.portfolio && result.portfolio.totalTrades) || 0,
      } : null,
    };
    await db.collection(COLLECTION).updateOne(
      { _id: String(jobId) },
      { $set: doc },
      { upsert: true }
    );
    deps.logger && deps.logger.info('[provenance] recorded jobId=' + jobId + ' pf=' + (doc.result && doc.result.pf));
    return doc;
  } catch (e) {
    deps.logger && deps.logger.warn('[provenance] record failed: ' + e.message);
    return null;
  }
}

async function get(jobId) {
  if (!deps.getDB) return null;
  return deps.getDB().collection(COLLECTION).findOne({ _id: String(jobId) });
}

async function list(limit) {
  if (!deps.getDB) return [];
  return deps.getDB().collection(COLLECTION)
    .find({}, { projection: { dataSnapshot: 0 } })
    .sort({ recordedAt: -1 })
    .limit(Math.min(limit || 50, 200))
    .toArray();
}

async function diff(jobIdA, jobIdB) {
  if (!deps.getDB) return { error: 'db not ready' };
  const a = await get(jobIdA);
  const b = await get(jobIdB);
  if (!a || !b) return { error: 'one or both provenance docs not found' };

  const changes = [];
  if (a.git.sha !== b.git.sha) changes.push({ field: 'git.sha', from: a.git.shortSha, to: b.git.shortSha, note: 'کد تغییر کرد' });
  if (a.versions.logic !== b.versions.logic) changes.push({ field: 'versions.logic', from: a.versions.logic, to: b.versions.logic });
  if (a.versions.costModel !== b.versions.costModel) changes.push({ field: 'versions.costModel', from: a.versions.costModel, to: b.versions.costModel });
  if (a.configsHash !== b.configsHash) {
    for (const k of ['mode', 'optionType', 'qualityLevel', 'dateFrom', 'dateTo']) {
      if (JSON.stringify(a.config[k]) !== JSON.stringify(b.config[k])) {
        changes.push({ field: 'config.' + k, from: a.config[k], to: b.config[k] });
      }
    }
    const aS = JSON.stringify([...(a.config.symbols || [])].sort());
    const bS = JSON.stringify([...(b.config.symbols || [])].sort());
    if (aS !== bS) changes.push({ field: 'config.symbols', from: a.config.symbols, to: b.config.symbols });
    const aT = JSON.stringify([...(a.config.strategies || [])].sort());
    const bT = JSON.stringify([...(b.config.strategies || [])].sort());
    if (aT !== bT) changes.push({ field: 'config.strategies', from: a.config.strategies, to: b.config.strategies });
    if (JSON.stringify(a.config.panels) !== JSON.stringify(b.config.panels)) {
      changes.push({ field: 'config.panels', from: a.config.panels, to: b.config.panels });
    }
  }

  const resultDelta = {};
  for (const k of ['pf', 'totalReturnPct', 'maxDD', 'sharpe', 'detailsCount', 'acceptedTrades', 'totalTrades']) {
    const av = a.result && a.result[k] != null ? a.result[k] : null;
    const bv = b.result && b.result[k] != null ? b.result[k] : null;
    if (av !== bv) resultDelta[k] = { from: av, to: bv, delta: (bv || 0) - (av || 0) };
  }

  return {
    a: { jobId: jobIdA, recordedAt: a.recordedAt, git: a.git, result: a.result },
    b: { jobId: jobIdB, recordedAt: b.recordedAt, git: b.git, result: b.result },
    changes,
    resultDelta,
    identical: changes.length === 0,
  };
}

module.exports = { init, record, get, list, diff };