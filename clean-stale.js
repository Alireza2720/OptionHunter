'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

const files = [
    'backend/api/routes/pipeline.routes.js',
    'backend/core/backtest.js',
    'backend/core/signals.js',
    'backend/jobs/monthly-report.job.js',
    'backend/services/backtest-orchestrator.service.js',
    'backend/services/backtest.service.js',
    'backend/services/config.service.js',
    'backend/services/dual-stage-pipeline.service.js',
    'backend/services/pipeline.service.js',
    'backend/strategies.js'
];

const dead = ['supply_demand','orb','ensemble','vwap_bounce','rsi_pullback',
    'macd_trend','ichimoku_cloud','ema_stack','rsi_oversold_bounce',
    'gap_fill','atr_expansion','pairs_spread','ou_mean_reversion',
    'volatility_breakout','bb_squeeze'];

const stamp = Date.now();
const backupDir = path.join(ROOT, `_clean-backup-${stamp}`);
fs.mkdirSync(backupDir);

console.log('backup →', backupDir);

for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log('  skip (missing):', rel); continue; }
    const flat = rel.replace(/[\\/]/g, '_');
    fs.copyFileSync(abs, path.join(backupDir, flat));
    console.log('  copied:', rel);
}

console.log('\n=== cleaning ===');

for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    let src = fs.readFileSync(abs, 'utf8');
    const orig = src;
    let count = 0;

    // Remove strings like 'strategy_id' or "strategy_id" from EXCLUDED sets / comments
    for (const id of dead) {
        const re = new RegExp(`(['"\`])${id}\\1\\s*,\\s*`, 'g');
        const before = src;
        src = src.replace(re, '');
        if (src !== before) count++;
    }

    // Collapse possible leftover ", ," in Sets
    src = src.replace(/,\s*,/g, ',');

    if (src !== orig) {
        fs.writeFileSync(abs, src, 'utf8');
        console.log(`  [OK]   ${rel} (${count} patterns)`);
    } else {
        console.log(`  [--]   ${rel}`);
    }
}

console.log('\n=== VERIFY ===');
try {
    delete require.cache[require.resolve('./backend/strategies')];
    const s = require('./backend/strategies');
    const ids = Object.keys(s.STRATEGIES);
    console.log('  strategies load:', ids.length, 'items');
    const expected = ['tsmom','dual_thrust','rsi2_mr','orb_pro','gap_and_go',
                      'smc_unicorn','ob_sweep','ob_after_sweep','momentum_12_1',
                      'short_term_reversal','low_vol_anomaly','donchian','sector_momentum'];
    const missing = expected.filter(x => !ids.includes(x));
    if (missing.length) { console.log('  MISSING:', missing.join(',')); process.exit(2); }
    console.log('  ✓ all 13 strategies still present');

    // Syntax check every file
    const cp = require('child_process');
    for (const rel of files) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) continue;
        try {
            cp.execFileSync('node', ['--check', abs], { stdio: 'pipe' });
            console.log('  ✓ syntax OK:', rel);
        } catch (e) {
            console.log('  ✗ SYNTAX FAIL:', rel, e.stderr?.toString() || '');
            process.exit(3);
        }
    }
    console.log('\n=== SUCCESS ===');
} catch (e) {
    console.error('VERIFY FAILED:', e.message);
    console.error('Restore from:', backupDir);
    process.exit(1);
}