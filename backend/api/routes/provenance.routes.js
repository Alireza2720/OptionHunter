'use strict';
// ============================================================
// provenance.routes.js — F1: Backtest Provenance API
// ============================================================

const provenance = require('../../services/provenance.service');

function register(app, deps) {

  // list recent runs
  app.get('/api/backtest/provenance', async (req, res, next) => {
    try {
      const limit = Math.min(+(req.query.limit || 50), 200);
      const list = await provenance.list(limit);
      res.json({ count: list.length, list });
    } catch (e) { next(e); }
  });

  // diff two runs
  app.get('/api/backtest/provenance/diff', async (req, res, next) => {
    try {
      const { a, b } = req.query;
      if (!a || !b) return res.status(400).json({ error: 'پارامترهای a و b لازم است' });
      const d = await provenance.diff(a, b);
      if (d.error) return res.status(404).json(d);
      res.json(d);
    } catch (e) { next(e); }
  });

  // get one
  app.get('/api/backtest/provenance/:jobId', async (req, res, next) => {
    try {
      const p = await provenance.get(req.params.jobId);
      if (!p) return res.status(404).json({ error: 'provenance یافت نشد' });
      res.json(p);
    } catch (e) { next(e); }
  });

  if (deps.logger) deps.logger.info('[provenance] routes registered');
}

module.exports = { register };