'use strict';
// pack.js — بسته‌بندی کل پروژه در یک فایل
// اجرا: node pack.js
//
// گزینه‌ها:
//   node pack.js              → ساخت PACKED.txt
//   node pack.js --list       → فقط لیست فایل‌ها
//   node pack.js --clean      → پاک کردن PACKED.txt
//   node pack.js --dry        → چک بدون نوشتن

const fs = require('fs');
const path = require('path');

// ============================================================
// تشخیص ROOT پروژه
// ============================================================
function isValidRoot(dir) {
    if (!dir) return false;
    try {
        return fs.existsSync(path.join(dir, 'backend')) ||
               fs.existsSync(path.join(dir, 'frontend')) ||
               fs.existsSync(path.join(dir, 'collector'));
    } catch (_) { return false; }
}

const candidates = [
    path.dirname(process.argv[1] || ''),
    __dirname,
    process.cwd(),
    process.env.INIT_CWD,
    process.env.VSCODE_CWD,
].filter(Boolean);

let ROOT = null;
for (const c of candidates) {
    if (isValidRoot(c)) { ROOT = c; break; }
}
if (!ROOT) {
    console.error('❌ پوشه‌ی پروژه پیدا نشد');
    process.exit(1);
}

const OUT_FILE = path.join(ROOT, 'PACKED.txt');

// ============================================================
// فیلترها
// ============================================================
const SKIP_DIRS = new Set([
    'node_modules', 'venv', 'ENV',
    '.git',
    '__pycache__', '.pytest_cache', 'logs',
    'packed', 'dist', 'build', 'coverage',
    '.next', '.cache', '.idea',
    'eggs', '.eggs', '.tox', 'htmlcov',
    'Include', 'Lib',    // venv artifacts
]);

const SKIP_FILES = new Set([
    '.env',                    // رازآمیز
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'PACKED.txt',
    '.DS_Store',
    'Thumbs.db',
]);

const INCLUDE_EXTS = new Set([
    '.js', '.mjs', '.cjs',
    '.py',
    '.json',
    '.sh', '.bash',
    '.yml', '.yaml',
    '.html', '.htm',
    '.css',
    '.md',
    '.txt',
    '.conf', '.config',
    '.toml', '.ini',
]);

const INCLUDE_NAMES = new Set([
    '.env.example',
    '.gitignore',
    '.dockerignore',
    'Dockerfile',
    'Makefile',
    'Procfile',
    'requirements.txt',
]);

const MAX_FILE_SIZE = 500 * 1024;   // 500KB per file

function shouldSkipDir(name) {
    return SKIP_DIRS.has(name);
}

function shouldSkipFile(rel, name) {
    if (SKIP_FILES.has(name)) return true;
    if (name.startsWith('PACKED') || name.startsWith('pack-')) return true;
    if (name.startsWith('tempCodeRunner')) return true;
    if (name.endsWith('.log') || name.endsWith('.pyc')) return true;
    if (name.endsWith('.min.js') || name.endsWith('.min.css')) return true;
    return false;
}

function shouldInclude(name) {
    if (INCLUDE_NAMES.has(name)) return true;
    // فایل‌های مخفی (با .) رو فقط اگه تو INCLUDE_NAMES باشن قبول کن
    if (name.startsWith('.')) return false;
    const ext = path.extname(name).toLowerCase();
    return INCLUDE_EXTS.has(ext);
}

// ============================================================
// Walk — همه‌چیز رو پیدا می‌کنه (auto-discovery)
// ============================================================
function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }

    for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(ROOT, full);

        if (e.isDirectory()) {
            if (shouldSkipDir(e.name)) continue;
            walk(full, out);
        } else if (e.isFile()) {
            if (shouldSkipFile(rel, e.name)) continue;
            if (!shouldInclude(e.name)) continue;

            try {
                const st = fs.statSync(full);
                if (st.size > MAX_FILE_SIZE) {
                    out.push({ path: full, rel, skipped: 'too-large', size: st.size });
                    continue;
                }
            } catch (_) { continue; }

            out.push({ path: full, rel });
        }
    }
}

// ============================================================
// ساخت محتوا
// ============================================================
function build() {
    const files = [];
    walk(ROOT, files);

    // sort by relative path
    files.sort((a, b) => a.rel.localeCompare(b.rel));

    const lines = [];
    const bar = '═'.repeat(78);

    // ─── HEADER ───
    lines.push(bar);
    lines.push('  OptionHunter — PACKED SOURCE');
    lines.push('  Generated: ' + new Date().toISOString());
    lines.push('  Root: ' + ROOT);
    lines.push(bar);
    lines.push('');

    // ─── فهرست ───
    lines.push('📂 فهرست فایل‌ها:');
    lines.push('');
    let n = 0;
    let totalBytes = 0;
    for (const f of files) {
        if (f.skipped) {
            lines.push(`   [SKIP] ${f.rel}  (${Math.round(f.size/1024)} KB — too large)`);
            continue;
        }
        n++;
        let size = 0;
        try { size = fs.statSync(f.path).size; } catch (_) {}
        totalBytes += size;
        lines.push(`   ${String(n).padStart(3)}. ${f.rel}  (${Math.round(size/1024)} KB)`);
    }
    lines.push('');
    lines.push(`   مجموع: ${n} فایل، ${Math.round(totalBytes/1024)} KB`);
    lines.push('');
    lines.push(bar);
    lines.push('');
    lines.push('');

    // ─── محتوا ───
    let idx = 0;
    for (const f of files) {
        if (f.skipped) continue;
        idx++;
        let content = '';
        try { content = fs.readFileSync(f.path, 'utf8'); }
        catch (e) { content = '<<< read error: ' + e.message + ' >>>'; }

        const lineCount = content.split('\n').length;
        const size = Buffer.byteLength(content, 'utf8');

        lines.push(bar);
        lines.push(`FILE #${idx}: ${f.rel}`);
        lines.push(`LINES: ${lineCount}  SIZE: ${size} bytes`);
        lines.push(bar);
        lines.push('');
        lines.push(content);
        if (!content.endsWith('\n')) lines.push('');
        lines.push('');
        lines.push(`─── END ${f.rel} ───`);
        lines.push('');
        lines.push('');
    }

    // ─── FOOTER ───
    lines.push(bar);
    lines.push('  END OF PACKED');
    lines.push(`  ${n} files, ${Math.round(totalBytes/1024)} KB`);
    lines.push(bar);

    return { text: lines.join('\n'), files: n, bytes: totalBytes };
}

// ============================================================
// Main
// ============================================================
function main() {
    const argv = process.argv.slice(2);

    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('استفاده: node pack.js');
        console.log('  → PACKED.txt (کل پروژه در یک فایل)');
        console.log('');
        console.log('گزینه‌ها:');
        console.log('  --list      فقط لیست فایل‌ها');
        console.log('  --clean     پاک کردن PACKED.txt');
        console.log('  --dry       چک بدون نوشتن');
        return;
    }

    if (argv.includes('--clean')) {
        if (fs.existsSync(OUT_FILE)) {
            fs.unlinkSync(OUT_FILE);
            console.log('✅ PACKED.txt پاک شد');
        } else {
            console.log('ℹ️  PACKED.txt وجود نداره');
        }
        return;
    }

    if (argv.includes('--list')) {
        const files = [];
        walk(ROOT, files);
        files.sort((a, b) => a.rel.localeCompare(b.rel));
        let totalBytes = 0;
        for (const f of files) {
            let size = 0;
            try { size = fs.statSync(f.path).size; } catch (_) {}
            totalBytes += size;
            console.log(`  ${f.rel.padEnd(60)} ${Math.round(size/1024)} KB`);
        }
        console.log('');
        console.log(`  مجموع: ${files.length} فایل، ${Math.round(totalBytes/1024)} KB`);
        return;
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  OptionHunter Packer — Single File                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('  ROOT : ' + ROOT);
    console.log('  OUT  : ' + OUT_FILE);
    console.log('');

    const t0 = Date.now();
    const { text, files, bytes } = build();

    if (argv.includes('--dry')) {
        console.log(`  DRY RUN: ${files} files, ${Math.round(bytes/1024)} KB`);
        return;
    }

    fs.writeFileSync(OUT_FILE, text, 'utf8');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    const outSize = Math.round(fs.statSync(OUT_FILE).size / 1024);

    console.log(`  ✅ فایل ساخته شد`);
    console.log(`     فایل‌ها: ${files}`);
    console.log(`     محتوا: ${Math.round(bytes/1024)} KB`);
    console.log(`     PACKED.txt: ${outSize} KB`);
    console.log(`     زمان: ${elapsed}s`);
    console.log('');
    console.log('  📄 خروجی: ' + OUT_FILE);
}

main();