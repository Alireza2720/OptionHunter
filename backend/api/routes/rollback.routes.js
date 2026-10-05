'use strict';
// ============================================================
// rollback.routes.js — restore configs from archive
// ============================================================

function register(app, deps) {
    const { getDB, logger } = deps;
    const { ObjectId } = require('mongodb');
    const { COLLECTIONS } = require('../../config/constants');

    // List available archives
    app.get('/api/configs/archives', async (req, res, next) => {
        try {
            const db = getDB();
            const list = await db.collection('strategy_configs_archive')
                .find({})
                .project({ configs: 0 })
                .sort({ archivedAt: -1 })
                .limit(30)
                .toArray();
            res.json({ archives: list });
        } catch (e) { next(e); }
    });

    // Preview archive contents
    app.get('/api/configs/archives/:id', async (req, res, next) => {
        try {
            const db = getDB();
            const doc = await db.collection('strategy_configs_archive')
                .findOne({ _id: new ObjectId(req.params.id) });
            if (!doc) return res.status(404).json({ error: 'archive یافت نشد' });
            res.json(doc);
        } catch (e) { next(e); }
    });

    // Restore
    app.post('/api/configs/restore/:id', async (req, res, next) => {
        try {
            const db = getDB();
            const archive = await db.collection('strategy_configs_archive')
                .findOne({ _id: new ObjectId(req.params.id) });
            if (!archive || !Array.isArray(archive.configs)) {
                return res.status(404).json({ error: 'archive یافت نشد' });
            }

            // Archive current before restore (safety)
            const current = await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({}).toArray();
            if (current.length) {
                await db.collection('strategy_configs_archive').insertOne({
                    archivedAt: new Date(),
                    reason: 'pre-restore-' + req.params.id,
                    count: current.length,
                    configs: current
                });
            }

            // Clear current
            await db.collection(COLLECTIONS.STRATEGY_CONFIGS).deleteMany({});

            // Restore (regenerate _id to avoid conflicts if archive had same ids)
            const toInsert = archive.configs.map(c => {
                const copy = { ...c };
                delete copy._id;
                return copy;
            });
            if (toInsert.length) {
                await db.collection(COLLECTIONS.STRATEGY_CONFIGS).insertMany(toInsert);
            }

            // Clear signals_state orphans
            const newIds = (await db.collection(COLLECTIONS.STRATEGY_CONFIGS).find({}, { projection: { _id: 1 } }).toArray())
                .map(x => String(x._id));
            await db.collection(COLLECTIONS.SIGNALS_STATE).deleteMany({ configId: { $nin: newIds } });

            logger && logger.info('restored ' + toInsert.length + ' configs from archive ' + req.params.id);
            res.json({ ok: true, restored: toInsert.length });
        } catch (e) { next(e); }
    });

    logger && logger.info('[rollback] routes registered');
}

module.exports = { register };
