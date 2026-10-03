'use strict';
// ============================================================
// doctor.routes.js — اجرای OHDoctor از UI
// ============================================================
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../../config/constants');

const LOGS = path.resolve(__dirname, '..', '..', '..', 'logs');
const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'monitor.js');

// 🆕 عنوان ۲۴ بخش برای پیش‌نمایش در Activities
const OHDOCTOR_SECTIONS = [
    'ENVIRONMENT', 'STRUCTURE', 'SYNTAX', 'BUG PATTERNS', 'CONFIG',
    'PM2', 'SYSTEMD', 'MONGODB', 'BACKEND HTTP', 'COLLECTOR HTTP',
    'CROSS-SERVICE', 'DATA GAP', 'LIVE TICK', 'STRATEGY DRY RUN', 'REGIME',
    'JOURNAL', 'PORTFOLIO', 'DUAL-STAGE PIPELINE', 'BACKTEST MATRIX',
    'BALE/TELEGRAM', 'PERFORMANCE', 'SECURITY', 'LOG TAIL',
    // 🆕 ۱۰ بخش جدید
    'BACKUP', 'CRON', 'SSL/TLS', 'DISK', 'MEMORY LEAK',
    'DATA INTEGRITY', 'SIGNAL QUALITY', 'FAILED JOBS', 'NETWORK', 'OPEN POSITIONS',
    'ENRICHMENT',
    // FINAL
    'FINAL REPORT',
];

let currentJob = null;   // { startedAt, pid, outputFile, status, exitCode, args, dbJobId }

function register(app, deps) {
    const { logger, getDB } = deps;

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

            // 🛡 چک RAM قبل از شروع
            const os = require('os');
            const freeMB = os.freemem() / 1048576;
            if (freeMB < 300) {
                return res.status(503).json({
                    error: `RAM آزاد کم است (${freeMB.toFixed(0)}MB < 300MB) — چند دقیقه صبر کنید یا سرور را ری‌استارت کنید`,
                    freeMB: Math.round(freeMB),
                });
            }

            const opts = req.body || {};

            // 🕐 چک ساعت بازار (اجباری — فقط با forceHours اجازه بده)
            const now = new Date();
            const tehran = new Date(now.getTime() + 3.5 * 3600 * 1000);
            const wd = tehran.getUTCDay();
            const mins = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();
            const isTradingDay = [6, 0, 1, 2, 3].includes(wd);
            const SAFE_START = 8 * 60 + 45;
            const SAFE_END = 12 * 60 + 45;
            const inDanger = isTradingDay && mins >= SAFE_START && mins <= SAFE_END;
            if (inDanger && !opts.forceHours) {
                return res.status(409).json({
                    error: 'بازار یا آستانه‌ی بازار باز است — اجرای OHDoctor الان مجاز نیست',
                    hint: 'بعد از ساعت 12:45 امتحان کنید، یا در حالت Safe Mode با gزینه forceHours',
                    tehranTime: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
                });
            }

            // 🚦 چک job های فعال (اگر --skip-heavy نبود)
            if (!opts.skipHeavy) {
                try {
                    const MongoClient = require('mongodb').MongoClient;
                    const uri = require('../../config/env').get().MONGO_URI;
                    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
                    await client.connect();
                    const db = client.db('trading_bot');
                    const activeCount = await db.collection('backtest_jobs').countDocuments({
                        status: { $in: ['QUEUED', 'RUNNING', 'COMPUTING'] },
                    });
                    await client.close();
                    if (activeCount > 0 && !opts.forceHours) {
                        return res.status(409).json({
                            error: `${activeCount} job در حال اجراست — OHDoctor سنگین می‌تواند تداخل کند`,
                            hint: 'صبر کنید یا با skipHeavy=true فقط بخش‌های سبک را اجرا کنید',
                            activeJobs: activeCount,
                        });
                    }
                } catch (e) {
                    // اگر Mongo در دسترس نبود، skip کن
                    logger && logger.warn(`[doctor] job-idle check failed: ${e.message}`);
                }
            }
            const args = [SCRIPT, '--doctor'];   // 🆕 اجباری برای child process
            if (opts.skipHeavy) args.push('--skip-heavy');
            if (opts.skipPipeline) args.push('--skip-pipeline');
            if (opts.skipBacktest) args.push('--skip-backtest');
            if (opts.skipLive) args.push('--skip-live');
            if (opts.sendReport) args.push('--send-report');
            if (opts.verbose) args.push('--verbose');
            // 🆕 چون از UI اجرا می‌شود، از قبل چک کردیم؛ به اسکریپت هم بگو از گیت رد شود
            args.push('--force-hours');
            if (Array.isArray(opts.sections) && opts.sections.length) {
                args.push(`--sections=${opts.sections.join(',')}`);
            }

            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const outputFile = path.join(LOGS, `ohdoctor-ui-${stamp}.log`);
            if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });
            const outStream = fs.createWriteStream(outputFile, { flags: 'a' });

            // 🆕 ثبت job در MongoDB تا در Activities نمایش داده شود
            const db = getDB();
            const jobDoc = {
                type: 'ohdoctor',
                status: 'RUNNING',
                payload: {
                    skipHeavy: !!opts.skipHeavy,
                    skipPipeline: !!opts.skipPipeline,
                    skipBacktest: !!opts.skipBacktest,
                    skipLive: !!opts.skipLive,
                    sections: opts.sections || null,
                },
                progress: {
                    current: 0,
                    total: OHDOCTOR_SECTIONS.length,
                    message: 'شروع...',
                    // 🆕 chunks = یک ورودی برای هر بخش
                    chunks: OHDOCTOR_SECTIONS.map((title, i) => ({
                        idx: i,
                        label: `S${i + 1} ${title}`,
                        status: 'PENDING',
                        ok: 0, warn: 0, fail: 0,
                    })),
                },
                cancelRequested: false,
                createdAt: new Date(),
                startedAt: new Date(),
                updatedAt: new Date(),
            };
            const ins = await db.collection(COLLECTIONS.BACKTEST_JOBS).insertOne(jobDoc);
            const dbJobId = String(ins.insertedId);

            // 🆕 jobId به script می‌فرستیم
            args.push(`--job-id=${dbJobId}`);

            // 🛡 با nice -n 15 اجرا کن (کم‌اولویت CPU)
            const child = spawn('nice', ['-n', '15', 'node', ...args], {
                cwd: path.resolve(__dirname, '..', '..', '..'),
                env: { ...process.env, OH_DOCTOR_UI: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            // 🆕 parse stdout برای progress markers
            let stdoutBuf = '';
            child.stdout.on('data', (chunk) => {
                const s = chunk.toString();
                outStream.write(s);
                stdoutBuf += s;
                const re = />>>OHDOCTOR_PROGRESS:(\{[^\n]+\})/g;
                let m;
                while ((m = re.exec(stdoutBuf)) !== null) {
                    try {
                        let p;
                        try { p = JSON.parse(m[1]); } catch (_) { continue; }
                        const chunkPatch = {};
                        chunkPatch[`progress.chunks.${p.section - 1}.status`] = 'DONE';
                        chunkPatch[`progress.chunks.${p.section - 1}.ok`] = p.ok;
                        chunkPatch[`progress.chunks.${p.section - 1}.warn`] = p.warn;
                        chunkPatch[`progress.chunks.${p.section - 1}.fail`] = p.fail;
                        if (p.section < 24) {
                            chunkPatch[`progress.chunks.${p.section}.status`] = 'RUNNING';
                        }
                        db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                            { _id: ins.insertedId },
                            {
                                $set: {
                                    'progress.current': p.section,
                                    'progress.total': p.total,
                                    'progress.message': `[S${p.section}/${p.total}] ${p.title} — ✅${p.ok} ⚠️${p.warn} ❌${p.fail}`,
                                    updatedAt: new Date(),
                                    ...chunkPatch,
                                },
                            }
                        ).catch(() => {});
                    } catch (_) {}
                }
                // جلوگیری از رشد حافظه
                if (stdoutBuf.length > 100000) stdoutBuf = stdoutBuf.slice(-50000);
            });
            child.stderr.pipe(outStream);

            currentJob = {
                startedAt: new Date(),
                pid: child.pid,
                outputFile,
                status: 'running',
                exitCode: null,
                args,
                finishedAt: null,
                dbJobId,
            };

            // 🆕 در exit، DB job را DONE/FAILED کن
            child.on('exit', async (code) => {
                if (currentJob) {
                    currentJob.status = code === 0 ? 'done' : 'failed';
                    currentJob.exitCode = code;
                    currentJob.finishedAt = new Date();
                }
                try { outStream.end(); } catch (_) {}
                try {
                    const patch = {
                        status: code === 0 ? 'DONE' : 'FAILED',
                        finishedAt: new Date(),
                        updatedAt: new Date(),
                        error: code === 0 ? null : `exit code ${code}`,
                        'progress.current': 24,
                        'progress.message': code === 0
                            ? '✅ تکمیل'
                            : `❌ خطا (exit ${code})`,
                    };
                    // اتمام همه chunks
                    if (code === 0) {
                        for (let i = 0; i < OHDOCTOR_SECTIONS.length; i++) {
                            patch[`progress.chunks.${i}.status`] = 'DONE';
                        }
                    }
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: ins.insertedId },
                        { $set: patch }
                    );
                } catch (e) {
                    logger && logger.warn(`[doctor] failed to update DB job: ${e.message}`);
                }
                logger && logger.info(`[doctor] job finished: exit=${code}`);
            });
            child.on('error', async (e) => {
                if (currentJob) { currentJob.status = 'failed'; currentJob.error = e.message; }
                try {
                    await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: ins.insertedId },
                        { $set: {
                            status: 'FAILED',
                            error: e.message,
                            finishedAt: new Date(),
                            'progress.message': `spawn error: ${e.message}`,
                        } }
                    );
                } catch (_) {}
                logger && logger.error(`[doctor] spawn error: ${e.message}`);
            });

            res.json({
                jobId: dbJobId,                      // 🆕 برای trackJob در فرانت
                stamp,                               // 🆕 برای outputFile
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
    // POST /api/doctor/kill — متوقف کردن اجرای فعلی (هم in-memory، هم DB)
    // body: { jobId? } — اگر ارسال شود، از DB هم چک می‌شود
    // ------------------------------------------------------------------
    app.post('/api/doctor/kill', async (req, res, next) => {
        try {
            const targetJobId = (req.body && req.body.jobId) || null;
            const db = getDB();

            let killed = false;
            let message = '';

            // 1) kill در-memory job (اگر همین پروسه اجرا کرده)
            if (currentJob && currentJob.status === 'running') {
                try { process.kill(currentJob.pid, 'SIGTERM'); killed = true; } catch (_) {}
                currentJob.status = 'killed';
                currentJob.finishedAt = new Date();
            }

            // 2) به‌روزرسانی job در DB — چه از طریق currentJob، چه مستقیم با jobId
            const dbJobId = targetJobId || (currentJob && currentJob.dbJobId);
            if (dbJobId) {
                try {
                    const { ObjectId } = require('mongodb');
                    const patch = {
                        status: 'CANCELLED',
                        cancelRequested: true,
                        finishedAt: new Date(),
                        updatedAt: new Date(),
                        'progress.message': '🛑 توسط کاربر لغو شد',
                    };
                    // اتمام chunks باقی‌مانده — کار اضافه لازم نیست چون status کلی CANCELLED می‌شود
                    const upd = await db.collection(COLLECTIONS.BACKTEST_JOBS).updateOne(
                        { _id: new ObjectId(dbJobId), status: { $in: ['QUEUED', 'RUNNING', 'COMPUTING'] } },
                        { $set: patch }
                    );
                    if (upd.modifiedCount > 0) killed = true;
                } catch (e) {
                    logger && logger.warn(`[doctor] kill DB update failed: ${e.message}`);
                }
            }

            if (killed) {
                message = 'کنسل شد';
                logger && logger.info(`[doctor] job killed: ${dbJobId || 'in-memory'}`);
            } else {
                message = 'چیزی برای کنسل کردن نبود';
            }
            res.json({ success: killed, message, jobId: dbJobId });
        } catch (e) { next(e); }
    });

    logger && logger.info('[doctor] routes registered');
}

module.exports = { register };