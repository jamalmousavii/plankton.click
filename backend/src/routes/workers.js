const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../database/pool');
const { invalidateCache } = require('../cache');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../logger');
const { legacyToken } = require('../legacy');

// GET /api/workers — public network view. Deliberately excludes wallet_address
// and worker_token, and is bounded so it cannot dump the whole table.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, gpu_model, ram, cpu, status, uptime, total_tasks, earnings, current_model
         FROM workers
        WHERE status IS NULL OR status != 'removed'
        ORDER BY earnings DESC
        LIMIT 100`
    );

    res.json({
      success: true,
      workers: result.rows
    });

  } catch (err) {
    logger.error({ err }, 'GET /api/workers failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/workers — create a new worker for the current user (v3.13.0+).
// Each server-worker gets its own unique token (unlimited per user, no cap).
// v3.14.0: empty name defaults to "worker1"; token is single-use for display.
router.post('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;

    if (name !== undefined && name !== null && name !== '' && (typeof name !== 'string' || name.trim().length > 100)) {
      return res.status(400).json({ error: 'Valid name required (max 100 chars)' });
    }

    const workerToken = 'pw_' + crypto.randomBytes(32).toString('hex');
    const workerName = (name || '').trim() || 'worker1';

    const result = await pool.query(
      `INSERT INTO workers (user_id, wallet_address, name, worker_token, status)
       VALUES ($1, '', $2, $3, 'offline') RETURNING *`,
      [userId, workerName, workerToken]
    );

    invalidateCache('/api/workers');
    invalidateCache('/api/stats');
    res.status(201).json({ success: true, worker: result.rows[0] });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/workers/mine — get current user's workers (all, incl. offline)
// v3.14.0: hide worker_token after first successful connect (token_used_at set).
// GET /api/workers/mine — active workers of the logged-in user.
// v3.22.0: excludes removed rows AND workers with no contact for > 10 days
// (they live in GET /api/workers/history and come back automatically if the
// worker reconnects).
router.get('/mine', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, wallet_address, gpu_model, ram, cpu, models, current_model,
              status, uptime, total_tasks, earnings, created_at, last_seen,
              gpu_usage, ram_usage, cpu_usage, disk_usage,
              machine_id, name, worker_token, token_used_at,
              CASE WHEN token_used_at IS NOT NULL THEN NULL ELSE worker_token END AS visible_token
       FROM workers
       WHERE user_id = $1
         AND (status IS NULL OR status != 'removed')
         AND COALESCE(last_seen, created_at) >= NOW() - INTERVAL '10 days'
       ORDER BY created_at ASC`,
      [userId]
    );

    // Live multi-model roster (v3.41.0): installed models reported over WS
    // plus per-model down-marking. Falls back to the install-time `models`
    // column when the worker is offline / on an old binary.
    let liveModels = {};
    try {
      const wsServer = req.app.get('wsServer');
      if (wsServer && typeof wsServer.liveModels === 'function') {
        liveModels = wsServer.liveModels();
      }
    } catch (e) {}
    const parseModels = (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) return parsed;
        } catch (e) {}
        return v.split(',').map((m) => m.trim()).filter(Boolean);
      }
      return [];
    };
    // Return rows with worker_token null when already used (single-use display)
    const workers = result.rows.map(r => {
      const live = liveModels[r.id];
      const installed = live
        ? live.map((m) => m.id)
        : parseModels(r.models);
      const down = live ? live.filter((m) => m.down).map((m) => m.id) : [];
      return {
        ...r,
        worker_token: r.token_used_at ? null : r.worker_token,
        visible_token: undefined,
        installed_models: installed,
        models_down: down,
      };
    });

    res.json({
      success: true,
      workers,
      // Legacy: first worker (backward compat for old clients)
      worker: workers[0] || null
    });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/workers/mine/model — switch current model (worker_id required for multi-worker)
router.put('/mine/model', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { model, worker_id } = req.body;

    if (!model || typeof model !== 'string') {
      return res.status(400).json({ error: 'Model is required' });
    }
    if (model.length > 100) {
      return res.status(400).json({ error: 'Model name too long' });
    }
    // Allowlist: unknown tags fall back server-side, but never persist garbage.
    const MODELS = require('../models');
    const known = MODELS.some((m) => m.id === model);
    if (!known) {
      return res.status(400).json({ error: 'Unknown model' });
    }

    let result;
    if (worker_id) {
      // Scoped: only the user's own worker
      result = await pool.query(
        `UPDATE workers SET current_model = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND user_id = $3 AND (status IS NULL OR status != 'removed')
         RETURNING id, current_model`,
        [model, worker_id, userId]
      );
    } else {
      // Legacy: first worker of the user
      result = await pool.query(
        `UPDATE workers SET current_model = $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND (status IS NULL OR status != 'removed')
         RETURNING id, current_model`,
        [model, userId]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    res.json({ success: true, worker: result.rows[0] });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/workers/mine/:id — rename a worker (own workers only)
router.put('/mine/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const workerId = parseInt(req.params.id);
    const { name } = req.body;

    if (!workerId) {
      return res.status(400).json({ error: 'Worker id is required' });
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      return res.status(400).json({ error: 'Valid name required (max 100 chars)' });
    }

    const result = await pool.query(
      `UPDATE workers SET name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3 AND (status IS NULL OR status != 'removed')
       RETURNING id, name`,
      [name.trim(), workerId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    res.json({ success: true, worker: result.rows[0] });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/workers/mine/:id/token — rotate token for reinstall same machine (v3.14.0)
// Generates a new unique token, clears token_used_at so it can be shown again.
router.put('/mine/:id/token', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const workerId = parseInt(req.params.id);

    if (!workerId) {
      return res.status(400).json({ error: 'Worker id is required' });
    }

    const newToken = 'pw_' + crypto.randomBytes(32).toString('hex');

    const result = await pool.query(
      `UPDATE workers SET worker_token = $1, token_used_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3 AND (status IS NULL OR status != 'removed')
       RETURNING id, name, worker_token`,
      [newToken, workerId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    invalidateCache('/api/workers');
    res.json({ success: true, worker: result.rows[0] });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/workers/mine/:id — remove a worker (soft delete, own workers only)
// History (tasks/earnings) is preserved; worker stops receiving dispatches.
router.delete('/mine/:id', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const workerId = parseInt(req.params.id);

    if (!workerId) {
      return res.status(400).json({ error: 'Worker id is required' });
    }

    const result = await pool.query(
      `UPDATE workers SET status = 'removed', uninstalled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2 AND (status IS NULL OR status != 'removed')
       RETURNING id`,
      [workerId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    // Drop live WS connection if connected (force re-auth which will be rejected)
    const wsServer = req.app.get('wsServer');
    if (wsServer && wsServer.workers && wsServer.workers.get(workerId)) {
      try {
        const entry = wsServer.workers.get(workerId);
        wsServer.workers.delete(workerId);
        if (entry.ws) entry.ws.close();
      } catch (e) {}
    }

    invalidateCache('/api/workers');
    invalidateCache('/api/stats');
    res.json({ success: true, message: 'Worker removed. Task/earning history is preserved.' });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/workers/token — generate unique worker token for install script
router.post('/token', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Check if user already has a worker token
    const existing = await pool.query('SELECT worker_token FROM users WHERE id = $1', [userId]);
    if (existing.rows[0]?.worker_token) {
      return res.json({ success: true, worker_token: existing.rows[0].worker_token });
    }

    // Generate new unique token
    const workerToken = 'pw_' + crypto.randomBytes(32).toString('hex');

    await pool.query('UPDATE users SET worker_token = $1 WHERE id = $2', [workerToken, userId]);

    res.json({ success: true, worker_token: workerToken });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/workers/setup — register worker via install script (v3.13.0+).
// Token-first model: each server-worker has its own unique token, and the
// token IS the worker identity. Unlimited workers per user, no cap.
router.post('/setup', async (req, res) => {
  try {
    const { email, gpu_model, ram, cpu, models, machine_id, name } = req.body;
    const worker_token = legacyToken(req.body);

    if (!worker_token || typeof worker_token !== 'string') {
      return res.status(400).json({ error: 'Worker token is required' });
    }
    // Bound unbounded setup fields (install script sends free-form lscpu/free strings).
    // Non-strings become NULL — an object here used to be persisted as JSON text.
    const safeStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
    const safeGpu = safeStr(gpu_model, 100);
    const safeRam = safeStr(ram, 50);
    const safeCpu = safeStr(cpu, 200);
    const safeMachine = safeStr(machine_id, 100);
    const safeName = safeStr(name, 100);
    const safeModels = Array.isArray(models) ? models.filter((m) => typeof m === 'string').map((m) => m.slice(0, 100)).slice(0, 32) : ['llama3.1:8b'];

    const modelsJson = JSON.stringify(safeModels);

    // 1) Per-worker token: binds directly to its row (revives if removed).
    const workerResult = await pool.query(
      'SELECT id, user_id, status FROM workers WHERE worker_token = $1',
      [worker_token]
    );
    if (workerResult.rows.length > 0) {
      if (workerResult.rows[0].status === 'removed') {
        return res.status(401).json({ error: 'This worker was removed. Re-add it from your profile to use it again.' });
      }
      const workerId = workerResult.rows[0].id;
      const result = await pool.query(
        `UPDATE workers SET gpu_model = $1, ram = $2, cpu = $3, models = $4,
                machine_id = COALESCE($5, machine_id), name = COALESCE($6, name),
                status = 'online', token_used_at = COALESCE(token_used_at, CURRENT_TIMESTAMP),
                last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $7 RETURNING *`,
        [safeGpu, safeRam, safeCpu, modelsJson, safeMachine || null, (safeName || '').trim() || null, workerId]
      );
      invalidateCache('/api/workers');
      invalidateCache('/api/stats');
      return res.json({ success: true, worker: result.rows[0] });
    }

    // 2) Legacy account token (users.worker_token): only unambiguous when the
    // user has exactly 1 active worker; otherwise require the per-worker token.
    if (email) {
      const userResult = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND worker_token = $2',
        [email, worker_token]
      );
      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].id;
        const owned = await pool.query(
          `SELECT id FROM workers WHERE user_id = $1 AND (status IS NULL OR status != 'removed')
           ORDER BY id ASC`,
          [userId]
        );
        if (owned.rows.length === 1) {
          const result = await pool.query(
            `UPDATE workers SET gpu_model = $1, ram = $2, cpu = $3, models = $4, status = 'online', last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $5 RETURNING *`,
            [safeGpu, safeRam, safeCpu, modelsJson, owned.rows[0].id]
          );
          return res.json({ success: true, worker: result.rows[0] });
        }
        if (owned.rows.length > 1) {
          return res.status(409).json({ error: 'Multiple workers found. Use the per-worker token from your profile for this machine.' });
        }
      }
    }

    return res.status(401).json({ error: 'Invalid worker token' });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/workers/register — DISABLED (use /setup with email + token instead)
router.post('/register', authenticate, async (req, res) => {
  return res.status(403).json({ error: 'Manual registration disabled. Use /api/workers/setup with email and worker token.' });
});

// POST /api/workers/unregister — called by uninstall-*.sh (v3.22.0).
// The worker_token itself is the credential (same trust model as /setup): it
// proves control of that machine. Idempotent — an unknown or already-removed
// token still answers success so uninstall never fails on the server side.
router.post('/unregister', async (req, res) => {
  try {
    const worker_token = legacyToken(req.body || {});
    if (!worker_token || typeof worker_token !== 'string') {
      return res.status(400).json({ error: 'worker_token required' });
    }

    const result = await pool.query(
      `UPDATE workers SET status = 'removed', uninstalled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE worker_token = $1 AND (status IS NULL OR status != 'removed')
       RETURNING id`,
      [worker_token]
    );

    if (result.rows.length > 0) {
      // Drop a live WS connection so dispatch stops immediately.
      const wsServer = req.app.get('wsServer');
      if (wsServer && wsServer.workers && wsServer.workers.get(result.rows[0].id)) {
        try {
          const entry = wsServer.workers.get(result.rows[0].id);
          wsServer.workers.delete(result.rows[0].id);
          if (entry.ws) entry.ws.close();
        } catch (e) {}
      }
      invalidateCache('/api/workers');
      invalidateCache('/api/stats');
    }

    res.json({ success: true, unregistered: result.rows.length > 0 });
  } catch (err) {
    logger.error({ err }, 'Worker unregister failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/workers/history — workers removed from the dashboard or by the
// uninstall script, plus workers with no contact for > 10 days (auto-archived;
// they return to /mine automatically if they ever reconnect).
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, name, gpu_model, status, total_tasks, earnings,
              created_at, last_seen, uninstalled_at,
              CASE WHEN status = 'removed' THEN 'uninstalled' ELSE 'offline>10d' END AS reason
       FROM workers
       WHERE user_id = $1
         AND (status = 'removed'
              OR COALESCE(last_seen, created_at) < NOW() - INTERVAL '10 days')
       ORDER BY COALESCE(uninstalled_at, last_seen, created_at) DESC`,
      [userId]
    );

    // Summary over ALL workers ever added by this user (active included).
    const summary = await pool.query(
      `SELECT COUNT(*)::int AS total_added,
              COALESCE(SUM(total_tasks), 0)::int AS total_tasks,
              COALESCE(SUM(earnings), 0)::float AS total_earnings
       FROM workers WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true, workers: result.rows, summary: summary.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Worker history route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/workers/mine/:id/earnings — per-worker lifetime + 5-way earnings
// breakdown (v3.41.3). Owner-only and includes `removed` workers so uninstalled
// servers keep their full story ("this server earned X"). Unknown or
// foreign ids answer 404 (same existence-hiding rule as the other routes).
router.get('/mine/:id/earnings', authenticate, async (req, res) => {
  try {
    const workerId = parseInt(req.params.id, 10);
    if (!workerId) {
      return res.status(400).json({ error: 'Worker id is required' });
    }

    const m = await pool.query(
      `SELECT id, user_id, name, status, total_tasks, earnings,
              created_at, last_seen, uninstalled_at
         FROM workers WHERE id = $1`,
      [workerId]
    );
    // Ownership check doubles as the existence check: anything not ours is
    // a 404, whether missing or belonging to someone else.
    const row = m.rows[0];
    if (!row || row.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    // Same bucketing as GET /api/leaderboard/mine: tokens pot vs wallet vs
    // payer plan. Pre-v3.28 rows land in wallet (backfilled as wallet/free).
    const breakdown = { tokens: 0, wallet: 0, plus: 0, pro: 0, max: 0 };
    const bd = await pool.query(
      `SELECT source, plan_type, COALESCE(SUM(amount), 0) AS amount
         FROM worker_coin_earnings
        WHERE worker_id = $1 AND coin = 'USD'
        GROUP BY source, plan_type`,
      [workerId]
    );
    for (const r of bd.rows) {
      const amount = parseFloat(r.amount) || 0;
      if (r.source === 'tokens') {
        breakdown.tokens += amount;
      } else {
        const key = ['plus', 'pro', 'max'].includes(r.plan_type) ? r.plan_type : 'wallet';
        breakdown[key] += amount;
      }
    }

    res.json({
      success: true,
      worker: {
        id: row.id,
        name: row.name,
        status: row.status,
        total_tasks: row.total_tasks,
        earnings: row.earnings,
        created_at: row.created_at,
        last_seen: row.last_seen,
        uninstalled_at: row.uninstalled_at,
      },
      breakdown,
    });
  } catch (err) {
    logger.error({ err }, 'Worker earnings route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/workers/:id/heartbeat — requires the worker's own token (v3.18.4)
router.put('/:id/heartbeat', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, tasks_completed } = req.body;
    const worker_token = legacyToken(req.body);
    // Bounded like the WS heartbeat: the column is VARCHAR(50).
    const current_model = typeof req.body.current_model === 'string' && req.body.current_model
      ? req.body.current_model.slice(0, 50)
      : null;

    if (!worker_token || typeof worker_token !== 'string') {
      return res.status(401).json({ error: 'worker_token required' });
    }
    if (!id) {
      return res.status(400).json({ error: 'Worker id is required' });
    }

    const auth = await pool.query('SELECT id FROM workers WHERE id = $1 AND worker_token = $2', [id, worker_token]);
    if (auth.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid worker token' });
    }

    // Whitelist caller-controlled fields: a heartbeat may never resurrect a
    // removed worker, invent a status, or inflate the task counter.
    const statusValue = ['online', 'offline', 'busy'].includes(status) ? status : 'online';
    const taskDelta = Math.max(0, Math.min(1000, parseInt(tasks_completed, 10) || 0));

    const result = await pool.query(
      `UPDATE workers
       SET status = $1,
           uptime = CASE WHEN $1 = 'online' THEN LEAST(uptime + 0.1, 100) ELSE uptime END,
           total_tasks = total_tasks + $2,
           current_model = COALESCE($4, current_model),
           last_seen = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND (status IS NULL OR status != 'removed')
       RETURNING *`,
      [statusValue, taskDelta, id, current_model]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    res.json({
      success: true,
      worker: result.rows[0]
    });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/workers/:id — owner only (used to be public and leaked
// wallet_address + earnings for any worker id).
router.get('/:id', authenticate, async (req, res) => {
  try {
    // A non-numeric id used to reach Postgres and come back as a 500.
    const id = parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({ error: 'Worker id is required' });
    }

    const result = await pool.query(
      `SELECT id, wallet_address, gpu_model, ram, cpu, models, current_model, status, uptime,
              total_tasks, earnings, created_at, gpu_usage, ram_usage, cpu_usage, disk_usage,
              machine_id, name, token_used_at
         FROM workers
        WHERE id = $1 AND user_id = $2 AND (status IS NULL OR status != 'removed')`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Worker not found' });
    }

    res.json({
      success: true,
      worker: result.rows[0]
    });

  } catch (err) {
    logger.error({ err }, 'Worker route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
