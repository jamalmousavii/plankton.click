const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const MODELS = require('../models');
const { logger } = require('../logger');
const { modelTokenWeight } = require('../services/plans');

// GET /api/models
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    let models = MODELS;
    if (category) {
      models = MODELS.filter(m => m.category === category);
    }

    // Get worker counts per model. v3.41.0: live multi-model roster from the
    // WS registry (one worker counts in every bucket it serves) — the DB
    // GROUP BY current_model below is only the fallback when WS is down.
    // Models no longer in the catalog (e.g. a removed qwen3.6:27b) are
    // reported separately instead of being silently credited elsewhere.
    const workerCounts = {};
    let totalOnline = 0;
    const unknownModels = {};
    let live = null;
    try {
      const wsServer = req.app && req.app.get('wsServer');
      if (wsServer && typeof wsServer.onlineModelCounts === 'function') {
        live = wsServer.onlineModelCounts(false);
      }
    } catch (e) {}
    try {
      const knownIds = new Set(MODELS.map(m => m.id));
      if (live) {
        // Distinct workers (buckets below intentionally multi-count one
        // worker across every model it serves).
        try {
          const onlineResult = await pool.query(
            `SELECT COUNT(*)::int AS n FROM workers WHERE status = 'online'`
          );
          totalOnline = onlineResult.rows[0] ? onlineResult.rows[0].n : 0;
        } catch (e) {
          totalOnline = 0;
        }
        for (const [modelId, cnt] of Object.entries(live)) {
          if (knownIds.has(modelId)) {
            workerCounts[modelId] = (workerCounts[modelId] || 0) + cnt;
          } else {
            unknownModels[modelId] = (unknownModels[modelId] || 0) + cnt;
          }
        }
      } else {
        const onlineResult = await pool.query(
          `SELECT current_model, COUNT(*) as cnt
           FROM workers WHERE status = 'online'
           GROUP BY current_model`
        );
        for (const row of onlineResult.rows) {
          const cnt = parseInt(row.cnt, 10);
          const modelId = row.current_model || 'llama3.1:8b';
          totalOnline += cnt;
          if (knownIds.has(modelId)) {
            workerCounts[modelId] = (workerCounts[modelId] || 0) + cnt;
          } else {
            unknownModels[modelId] = (unknownModels[modelId] || 0) + cnt;
          }
        }
      }
    } catch (e) {
      logger.error({ err: e }, 'models.js: workers online query failed');
    }

    // Merge model data with worker counts
    const modelsWithWorkers = models.map(m => ({
      ...m,
      // Allowance tokens one token of this model burns (llama3.1:8b = 1).
      token_weight: modelTokenWeight(m.id),
      workers_online: workerCounts[m.id] || 0,
    }));

    res.json({
      success: true,
      models: modelsWithWorkers,
      workers_online_total: totalOnline,
      unknown_models: unknownModels,
    });
  } catch (err) {
    logger.error({ err }, 'GET /api/models failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/models/categories
router.get('/categories', (req, res) => {
  const categories = [...new Set(MODELS.map(m => m.category))];
  res.json({ success: true, categories });
});

module.exports = router;
