const pool = require('../database/pool');
const { logger } = require('../logger');
const { getCacheStats } = require('../cache');
const { isAdmin } = require('../middleware/auth');

// Readiness: fails when Postgres is down so nginx/load-balancer stop routing.
// Redis is report-only — caching is an optimisation, never a hard dependency.
// Public view: `status` reflects only the API itself (Postgres). Worker
// capacity (`online_workers`, `chat`) is operational data shown to admins only
// (send the admin's Bearer JWT); everyone else never sees the worker count.
async function healthHandler(req, res) {
  const cache = getCacheStats();
  let dbStatus = 'unknown';
  let dbOk = false;
  let dbLatencyMs = null;
  try {
    const startedAt = Date.now();
    await pool.query('SELECT 1');
    dbLatencyMs = Date.now() - startedAt;
    dbStatus = 'connected';
    dbOk = true;
  } catch (e) {
    dbStatus = 'disconnected';
    logger.error({ err: e }, 'Health check: Postgres unreachable');
  }

  const body = {
    status: dbOk ? 'ok' : 'degraded',
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis: cache.connected ? 'connected' : 'disconnected',
    postgres: dbStatus,
    db_latency_ms: dbLatencyMs,
    sentry: !!process.env.SENTRY_DSN,
  };

  // Worker-only inference: chat is usable iff at least one worker is online.
  // Keep HTTP 200 either way — pulling this box from rotation would take the
  // whole API down, not just chat.
  if (dbOk && req.user && await isAdmin(req.user.id)) {
    let onlineWorkers = null;
    try {
        const r = await pool.query("SELECT COUNT(*)::int AS n FROM workers WHERE status = 'online'");
      onlineWorkers = r.rows[0].n;
    } catch (e) {
      logger.error({ err: e }, 'Health check: worker count failed');
    }
    body.online_workers = onlineWorkers;
    body.chat = onlineWorkers > 0 ? 'ok' : 'no_workers';
  }

  res.status(dbOk ? 200 : 503).json(body);
}

module.exports = healthHandler;
