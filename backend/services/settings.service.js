'use strict';
// ============================================================
// settings.service.js — پوشش روی settings.js قدیمی
// ============================================================
// یک abstraction نازک روی فایل settings.js که از قبل وجود داره.
// اگر یه روزی خواستیم settings رو به یه ساختار جدید مهاجرت بدیم،
// این فایل به عنوان آداپتور عمل می‌کنه و مصرف‌کننده‌ها تغییر نمی‌کنن.
// ============================================================

let legacy = null;
let deps = { getDB: null };

function init(d) {
    deps = { ...deps, ...d };
    legacy = require('../settings.js');
    legacy.init({ getDB: d.getDB });
}

async function load() {
    return legacy.load();
}

async function save(partial) {
    return legacy.save(partial);
}

function get() { return legacy.get(); }
function entryWindow() { return legacy.entryWindow(); }

// سرمایه
function capital() { return legacy.capital(); }
function riskAmount() { return legacy.riskAmount(); }
function maxSymbolExposure() { return legacy.maxSymbolExposure(); }
function maxTotalExposure() { return legacy.maxTotalExposure(); }
function minCashReserve() { return legacy.minCashReserve(); }

// ضرایب سه‌لایه
function signalFactor(confluence) { return legacy.signalFactor(confluence); }
function levelFactor(level) { return legacy.levelFactor(level); }
function ivFactor(ivHv) { return legacy.ivFactor(ivHv); }

// هم‌گرایی
function confluenceTimeWindow() { return legacy.confluenceTimeWindow(); }
function multiConfirmerMin() { return legacy.multiConfirmerMin(); }
function multiConfirmerWindow() { return legacy.multiConfirmerWindow(); }
function minTargetPct() { return legacy.minTargetPct(); }

// پیش‌فرض استراتژی‌ها
function getStrategyDefaults(id) { return legacy.getStrategyDefaults(id); }
function getAllStrategyDefaults() { return legacy.getAllStrategyDefaults(); }
async function saveStrategyDefaults(o) { return legacy.saveStrategyDefaults(o); }
async function resetStrategyDefaults(id) { return legacy.resetStrategyDefaults(id); }

module.exports = {
    init, load, save,
    get, entryWindow,
    capital, riskAmount, maxSymbolExposure, maxTotalExposure, minCashReserve,
    signalFactor, levelFactor, ivFactor,
    confluenceTimeWindow, multiConfirmerMin, multiConfirmerWindow,
    minTargetPct,
    getStrategyDefaults, getAllStrategyDefaults,
    saveStrategyDefaults, resetStrategyDefaults
};