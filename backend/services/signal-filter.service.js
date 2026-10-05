'use strict';
// signal-filter.service.js — disabled (whitelist removed)
let deps = { getDB: null, logger: null, analysisService: null };
function init(d) { deps = { ...deps, ...d }; }
async function buildAndSaveWhitelist() { return { pairs: 0, strategies: [], symbols: 0, totalPairs: 0 }; }
async function getWhitelist() { return null; }
async function clear() { return; }
module.exports = { init, buildAndSaveWhitelist, getWhitelist, clear };
