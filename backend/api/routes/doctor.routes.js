'use strict';
// ============================================================
// doctor.routes.js — اجرای OHDoctor از UI
// ============================================================
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ObjectId } = require('mongodb');

const LOGS = path.resolve(__dirname, '..', '..', '..', 'logs');
const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'monitor.js');

let currentJob = null;   // { startedAt, pid, outputFile, status, exitCode, args }

function register(app, deps) {
    const { logger } = deps;

    // ------------------------------------------------------------------
    // POST /api/doctor/run
    // ------------------------------------------------------------------
    app.post('/api/doctor/run', async (req, res, next) => {
        try {
            if (currentJob && currentJob.status === 'running') {
                return res.status(409).json({
                    error: 'یک اجرای OHDoctor در حال انجام است',
                    job: { startedAt: currentJob.startedAt, pid: currentJob.pid, status: currentJob.status },
                });
            }
            const opts = req.body || {};
            const args = [SCRIPT];
            if (opts.skipHeavy) args.push('--skip-heavy');
            if (opts.skipPipeline) args.push('--skip-pipeline');
            if (opts.skipBacktest) args.push('--skip-backtest');
            if (opts.skipLive) args.push('--skip-live');
            if (opts.sendReport) args.push('--send-report');
            if (opts.verbose) args.push('--verbose');
            if (Array.isArray(opts.sections) && opts.sections.length) {
                args.push(`--sections=${opts.sections.join(',')}`);
            }

            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const outputFile = path.join(LOGS, `ohdoctor-ui-${stamp}.log`);
            if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });
            const outStream = fs.createWriteStream(outputFile, { flags: 'a' });

            const child = spawn('node', args, {
                cwd: path.resolve(__dirname, '..', '..', '..'),
                env: { ...process.env, OH_DOCTOR_UI: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            child.stdout.pipe(outStream);
            child.stderr.pipe(outStream);

            currentJob = {
                startedAt: new Date(),
                pid: child.pid,
                outputFile,
                status: 'running',
                exitCode: null,
                args,
                finishedAt: null,
            };

            child.on('exit', (code) => {
                if (currentJob) {
                    currentJob.status = code === 0 ? 'done' : 'failed';
                    currentJob.exitCode = code;
                    currentJob.finishedAt = new Date();
                }
                try { outStream.end(); } catch (_) {}
                logger && logger.info(`[doctor] job finished: exit=${code}`);
            });
            child.on('error', (e) => {
                if (currentJob) { currentJob.status = 'failed'; currentJob.error = e.message; }
                logger && logger.error(`[doctor] spawn error: ${e.message}`);
            });

            res.json({
                jobId: stamp,
                startedAt: currentJob.startedAt,
                pid: child.pid,
                outputFile: path.basename(outputFile),
            });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------------
    // GET /api/doctor/status
    // ------------------------------------------------------------------
    app.get('/api/doctor/status', (req, res) => {
        if (!currentJob) return res.json({ running: false });
        const fileSize = (() => { try { return fs.statSync(currentJob.outputFile).size; } catch (_) { return 0; } })();
        res.json({
            running: currentJob.status === 'running',
            startedAt: currentJob.startedAt,
            finishedAt: currentJob.finishedAt,
            pid: currentJob.pid,
            status: currentJob.status,
            exitCode: currentJob.exitCode,
            error: currentJob.error,
            outputFile: path.basename(currentJob.outputFile),
            fileSize,
        });
    });

    // ------------------------------------------------------------------
    // GET /api/doctor/tail — آخرین N خط
    // ------------------------------------------------------------------
    app.get('/api/doctor/tail', (req, res, next) => {
        try {
            const limit = Math.min(+(req.query.limit || 200), 5000);
            const fname = req.query.file;
            let filePath;
            if (fname && /^ohdoctor-[\w.-]+\.(log|txt|json)$/.test(fname)) {
                filePath = path.join(LOGS, fname);
            } else if (currentJob) {
                filePath = currentJob.outputFile;
            } else {
                return res.json({ lines: [], file: null });
            }
            if (!fs.existsSync(filePath)) return res.json({ lines: [], file: path.basename(filePath) });
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').slice(-limit);
            res.json({ file: path.basename(filePath), lines });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------------
    // GET /api/doctor/list — لیست گزارش‌های اخیر
    // ------------------------------------------------------------------
    app.get('/api/doctor/list', (req, res, next) => {
        try {
            if (!fs.existsSync(LOGS)) return res.json({ files: [] });
            const files = fs.readdirSync(LOGS)
                .filter((f) => /^ohdoctor-.*\.(log|txt|json)$/.test(f))
                .map((f) => {
                    const st = fs.statSync(path.join(LOGS, f));
                    return { name: f, size: st.size, mtime: st.mtime };
                })
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 50);
            res.json({ files });
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------------
    // GET /api/doctor/file/:name — فایل کامل
    // ------------------------------------------------------------------
    app.get('/api/doctor/file/:name', (req, res, next) => {
        try {
            const name = req.params.name;
            if (!/^ohdoctor-[\w.-]+\.(log|txt|json)$/.test(name)) {
                return res.status(400).json({ error: 'نام فایل نامعتبر' });
            }
            const p = path.join(LOGS, name);
            if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
            res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
            res.sendFile(p);
        } catch (e) { next(e); }
    });

    // ------------------------------------------------------------------
    // POST /api/doctor/kill — متوقف کردن اجرای فعلی
    // ------------------------------------------------------------------
    app.post('/api/doctor/kill', async (req, res, next) => {
        try {
            if (!currentJob || currentJob.status !== 'running') {
                return res.json({ success: false, message: 'چیزی در حال اجرا نیست' });
            }
            try { process.kill(currentJob.pid, 'SIGTERM'); } catch (_) {}
            currentJob.status = 'killed';
            currentJob.finishedAt = new Date();
            res.json({ success: true });
        } catch (e) { next(e); }
    });

    logger && logger.info('[doctor] routes registered');
}

module.exports = { register };