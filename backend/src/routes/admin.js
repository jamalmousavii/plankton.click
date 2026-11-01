// Admin panel API (v3.39.0: read views + full management actions).
// Every mutating route runs inside a transaction and writes an
// admin_audit_log row (who/what/target/reason/snapshot) in the SAME
// transaction — an action either lands with its audit trail or not at all.
const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate, requireAdmin, invalidateTokenVersion } = require('../middleware/auth');
const { logger } = require('../logger');
const { activatePlan, PLANS } = require('../services/plans');
const { withTransaction } = require('../database/tx');

const ROLES = ['user', 'worker', 'admin'];
const TICKET_STATUSES = ['open', 'answered', 'closed'];
const WORKER_STATUSES = ['offline', 'removed'];
const MAX_REASON = 500;
const MAX_LIST = 100;

function parseId(raw) {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function logAdminAction(client, { adminId, action, targetType, targetId, reason, payload }) {
  await client.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, reason, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, action, targetType, targetId, reason || null, payload ? JSON.stringify(payload) : null]
  );
}

function fail(res, err, msg) {
  logger.error({ err }, msg);
  res.status(500).json({ error: 'Server error' });
}

// ===========================================================================
// Dashboard
// ===========================================================================

// GET /api/admin/dashboard
router.get('/dashboard', authenticate, requireAdmin, async (req, res) => {
  try {
    const [workers, users, tasks, revenue, tickets] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'online' THEN 1 END) as online FROM workers`),
      pool.query('SELECT COUNT(*) as total FROM users'),
      pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed FROM tasks`),
      // Platform keeps 10% (workers get 90%)
      pool.query("SELECT COALESCE(SUM(cost * 0.1), 0) as platform_fees FROM tasks WHERE status = 'completed'"),
      pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'open' THEN 1 END) as open FROM tickets`),
    ]);

    res.json({
      success: true,
      dashboard: {
        workers: { total: parseInt(workers.rows[0].total), online: parseInt(workers.rows[0].online) },
        users: parseInt(users.rows[0].total),
        tasks: { total: parseInt(tasks.rows[0].total), completed: parseInt(tasks.rows[0].completed) },
        revenue: parseFloat(revenue.rows[0].platform_fees),
        tickets: { total: parseInt(tickets.rows[0].total), open: parseInt(tickets.rows[0].open) },
      }
    });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// ===========================================================================
// Users (read + management actions)
// ===========================================================================

// GET /api/admin/users — list with balances + active plan for the action dialogs
const USER_TYPES = ['all', 'worker', 'user', 'admin', 'banned'];
// recent = newest accounts; usage / spend = top users over the last 30 days
// (the admin-only replacement for the old public users leaderboard).
const USER_SORTS = {
  recent: 'u.created_at DESC',
  usage: 'tokens_30d DESC, u.created_at DESC',
  spend: 'spend_30d DESC, u.created_at DESC',
};

// Shared filter for the user list: free-text q (email / name / #id) and a
// type: worker = owns at least one non-removed worker, user = owns none and
// is not an admin, admin, banned.
function userFilter(q, type) {
  const where = [];
  const params = [];
  const text = String(q || '').trim().slice(0, 100);
  if (text) {
    const asId = parseId(text.replace(/^#/, ''));
    params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const like = `$${params.length}`;
    if (asId) {
      params.push(asId);
      where.push(`(u.email ILIKE ${like} OR u.name ILIKE ${like} OR u.id = $${params.length})`);
    } else {
      where.push(`(u.email ILIKE ${like} OR u.name ILIKE ${like})`);
    }
  }
  if (type === 'worker') where.push('COALESCE(w.worker_count, 0) > 0');
  else if (type === 'user') where.push("COALESCE(w.worker_count, 0) = 0 AND u.role <> 'admin'");
  else if (type === 'admin') where.push("u.role = 'admin'");
  else if (type === 'banned') where.push('u.banned');
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// GET /api/admin/users?q=&type=all|worker|user|admin|banned&sort=recent|usage|spend
// Balances + plan for the action dialog, plus usage at a glance: allowance
// burned today (model-weighted), raw tokens / spend / messages last 30 days.
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const type = USER_TYPES.includes(req.query.type) ? req.query.type : 'all';
    const sort = Object.prototype.hasOwnProperty.call(USER_SORTS, req.query.sort) ? req.query.sort : 'recent';
    const { where, params } = userFilter(req.query.q, type);
    params.push(MAX_LIST);
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.banned, u.created_at,
              COALESCE(cb.available, 0) AS usd_balance,
              COALESCE(tb.tokens, 0) AS token_balance,
              up.plan_type AS active_plan, up.expires_at AS plan_expires_at,
              COALESCE(w.worker_count, 0)::int AS worker_count,
              CASE WHEN dt.last_reset_date = (now() AT TIME ZONE 'utc')::date
                   THEN COALESCE(dt.tokens_used_today, 0) ELSE 0 END AS tokens_today,
              COALESCE(us.tokens_30d, 0)::bigint AS tokens_30d,
              COALESCE(us.spend_30d, 0) AS spend_30d,
              COALESCE(us.messages_30d, 0)::int AS messages_30d
         FROM users u
         LEFT JOIN user_coin_balances cb ON cb.user_id = u.id AND cb.coin = 'USD'
         LEFT JOIN user_token_balances tb ON tb.user_id = u.id
         LEFT JOIN daily_tokens dt ON dt.user_id = u.id
         LEFT JOIN LATERAL (
              SELECT plan_type, expires_at FROM user_plans p
               WHERE p.user_id = u.id AND p.status = 'active' AND p.expires_at > now()
               ORDER BY p.expires_at DESC LIMIT 1
         ) up ON true
         LEFT JOIN LATERAL (
              SELECT COUNT(*) AS worker_count FROM workers wk
               WHERE wk.user_id = u.id AND (wk.status IS NULL OR wk.status <> 'removed')
         ) w ON true
         LEFT JOIN LATERAL (
              SELECT SUM(t.tokens_used) AS tokens_30d, SUM(t.cost) AS spend_30d, COUNT(*) AS messages_30d
                FROM tasks t
               WHERE t.user_id = u.id AND t.status = 'completed'
                 AND t.created_at >= now() - interval '30 days'
         ) us ON true
        ${where}
        ORDER BY ${USER_SORTS[sort]}
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, users: result.rows, type, sort });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// GET /api/admin/users/:id/usage — last 30 days of token usage for one user:
// per-day and per-model totals plus today's allowance (used vs cap).
router.get('/users/:id/usage', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const user = await pool.query('SELECT id, email FROM users WHERE id = $1', [id]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const byDay = await pool.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS messages, COALESCE(SUM(tokens_used), 0)::bigint AS tokens,
              COALESCE(SUM(cost), 0) AS cost
         FROM tasks
        WHERE user_id = $1 AND status = 'completed' AND created_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 1 DESC`,
      [id]
    );
    const byModel = await pool.query(
      `SELECT model, COUNT(*)::int AS messages, COALESCE(SUM(tokens_used), 0)::bigint AS tokens,
              COALESCE(SUM(cost), 0) AS cost
         FROM tasks
        WHERE user_id = $1 AND status = 'completed' AND created_at >= now() - interval '30 days'
        GROUP BY model ORDER BY tokens DESC`,
      [id]
    );
    const today = await pool.query(
      `SELECT CASE WHEN last_reset_date = (now() AT TIME ZONE 'utc')::date
                   THEN tokens_used_today ELSE 0 END AS used
         FROM daily_tokens WHERE user_id = $1`,
      [id]
    );
    const { resolveCap } = require('../services/org');
    const { modelTokenWeight } = require('../services/plans');
    const cap = await resolveCap(id, null).then((r) => r.cap).catch(() => null);
    res.json({
      success: true,
      user: user.rows[0],
      today: { used: Number(today.rows[0]?.used || 0), cap },
      by_day: byDay.rows,
      by_model: byModel.rows.map((r) => ({ ...r, token_weight: modelTokenWeight(r.model) })),
    });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// PUT /api/admin/users/:id/role — { role: user|worker|admin }
router.put('/users/:id/role', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const role = String(req.body.role || '');
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (id === req.user.id) return res.status(409).json({ error: 'Cannot change your own role' });

    const updated = await withTransaction(async (client) => {
      const cur = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) return null;
      const before = cur.rows[0].role;
      const next = await client.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING id, role', [role, id]);
      await logAdminAction(client, {
        adminId: req.user.id, action: 'user.role', targetType: 'user', targetId: id,
        payload: { from: before, to: role },
      });
      return next.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    invalidateTokenVersion(id);
    res.json({ success: true, user: updated });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// PUT /api/admin/users/:id/ban — { banned: true|false } (blocks login + every request)
router.put('/users/:id/ban', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    if (typeof req.body.banned !== 'boolean') return res.status(400).json({ error: 'banned must be boolean' });
    if (id === req.user.id) return res.status(409).json({ error: 'Cannot ban yourself' });
    const banned = req.body.banned;

    const updated = await withTransaction(async (client) => {
      const cur = await client.query('SELECT banned FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) return null;
      const next = await client.query('UPDATE users SET banned = $1 WHERE id = $2 RETURNING id, banned', [banned, id]);
      await logAdminAction(client, {
        adminId: req.user.id, action: banned ? 'user.ban' : 'user.unban', targetType: 'user', targetId: id,
        payload: { banned },
      });
      return next.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    invalidateTokenVersion(id); // live sessions die on the next cached-state refresh (≤10s)
    res.json({ success: true, user: updated });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/users/:id/balance — { delta_usd, reason } (signed, ±$1M cap)
router.post('/users/:id/balance', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const delta = Number(req.body.delta_usd);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta_usd must be a non-zero number' });
    if (Math.abs(delta) > 1000000) return res.status(400).json({ error: 'delta_usd out of range (±1,000,000)' });
    if (reason.length < 3 || reason.length > MAX_REASON) {
      return res.status(400).json({ error: `reason required (3-${MAX_REASON} chars)` });
    }

    const result = await withTransaction(async (client) => {
      const cur = await client.query(
        "SELECT available FROM user_coin_balances WHERE user_id = $1 AND coin = 'USD' FOR UPDATE",
        [id]
      );
      if (cur.rows.length === 0) {
        const user = await client.query('SELECT id FROM users WHERE id = $1', [id]);
        if (user.rows.length === 0) return null;
        if (delta < 0) throw Object.assign(new Error('insufficient'), { status: 400 });
        await client.query(
          `INSERT INTO user_coin_balances (user_id, coin, chain, available) VALUES ($1, 'USD', 'usd', $2)`,
          [id, delta]
        );
        await logAdminAction(client, {
          adminId: req.user.id, action: 'user.balance', targetType: 'user', targetId: id,
          reason, payload: { delta_usd: delta, before: 0, after: delta },
        });
        return { id, balance: delta };
      }
      const before = parseFloat(cur.rows[0].available) || 0;
      const after = Math.round((before + delta) * 1e8) / 1e8;
      if (after < 0) throw Object.assign(new Error('insufficient'), { status: 400 });
      await client.query(
        "UPDATE user_coin_balances SET available = $1 WHERE user_id = $2 AND coin = 'USD'",
        [after, id]
      );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'user.balance', targetType: 'user', targetId: id,
        reason, payload: { delta_usd: delta, before, after },
      });
      return { id, balance: after };
    });
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, balance: result.balance });
  } catch (err) {
    if (err && err.status === 400) return res.status(400).json({ error: 'Balance would go negative' });
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/users/:id/tokens — { delta_tokens, reason } (token pot ±)
router.post('/users/:id/tokens', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const delta = Number(req.body.delta_tokens);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta)) {
      return res.status(400).json({ error: 'delta_tokens must be a non-zero integer' });
    }
    if (Math.abs(delta) > 1000000000000) return res.status(400).json({ error: 'delta_tokens out of range' });
    if (reason.length < 3 || reason.length > MAX_REASON) {
      return res.status(400).json({ error: `reason required (3-${MAX_REASON} chars)` });
    }

    const result = await withTransaction(async (client) => {
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (user.rows.length === 0) return null;
      const cur = await client.query('SELECT tokens FROM user_token_balances WHERE user_id = $1 FOR UPDATE', [id]);
      const before = cur.rows.length ? Number(cur.rows[0].tokens) || 0 : 0;
      const after = before + delta;
      if (after < 0) throw Object.assign(new Error('insufficient'), { status: 400 });
      await client.query(
        `INSERT INTO user_token_balances (user_id, tokens) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET tokens = $2, updated_at = now()`,
        [id, after]
      );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'user.tokens', targetType: 'user', targetId: id,
        reason, payload: { delta_tokens: delta, before, after },
      });
      return { id, tokens: after };
    });
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, tokens: result.tokens });
  } catch (err) {
    if (err && err.status === 400) return res.status(400).json({ error: 'Token balance would go negative' });
    fail(res, err, 'Admin route failed');
  }
});

// PUT /api/admin/users/:id/plan — { plan: free|plus|pro|max, days?: 1-365 }
// SETS the user's plan: every other active tier is cancelled first (the
// biggest active cap always wins, so a grant alone could never downgrade),
// then the chosen tier runs `days` from now (default: the tier's interval).
// plan 'free' just cancels — the user drops back to the Free allowance.
router.put('/users/:id/plan', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const plan = String(req.body.plan || '');
    if (plan !== 'free' && !PLANS[plan]) return res.status(400).json({ error: 'Invalid plan tier' });
    const days = req.body.days === undefined || req.body.days === null || req.body.days === ''
      ? (PLANS[plan] ? PLANS[plan].interval_days : 0)
      : Number(req.body.days);
    if (plan !== 'free' && (!Number.isInteger(days) || days < 1 || days > 365)) {
      return res.status(400).json({ error: 'days must be a whole number between 1 and 365' });
    }

    const updated = await withTransaction(async (client) => {
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (user.rows.length === 0) return null;
      const before = await client.query(
        `SELECT plan_type, expires_at FROM user_plans
          WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
        [id]
      );
      await client.query(
        `UPDATE user_plans SET status = 'cancelled'
          WHERE user_id = $1 AND status = 'active' AND plan_type <> $2`,
        [id, plan]
      );
      let row = null;
      if (plan !== 'free') {
        await client.query(
          `INSERT INTO user_plans (user_id, plan_type, status, started_at, expires_at)
                VALUES ($1, $2, 'active', now(), now() + ($3::int * interval '1 day'))
           ON CONFLICT (user_id, plan_type) DO UPDATE
              SET status = 'active', started_at = now(),
                  expires_at = now() + ($3::int * interval '1 day')`,
          [id, plan, days]
        );
        const after = await client.query(
          `SELECT plan_type, expires_at FROM user_plans
            WHERE user_id = $1 AND plan_type = $2 AND status = 'active'`,
          [id, plan]
        );
        row = after.rows[0] || null;
      }
      await logAdminAction(client, {
        adminId: req.user.id, action: 'user.plan', targetType: 'user', targetId: id,
        payload: { plan, days: plan === 'free' ? 0 : days, before: before.rows },
      });
      return { row };
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, plan: updated.row });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// ===========================================================================
// Tickets (admin side)
// ===========================================================================

// GET /api/admin/tickets?status=&q= — list with owner + preview
router.get('/tickets', authenticate, requireAdmin, async (req, res) => {
  try {
    const status = TICKET_STATUSES.includes(req.query.status) ? req.query.status : null;
    const q = String(req.query.q || '').trim().slice(0, 100);
    const result = await pool.query(
      `SELECT t.*, u.email, u.name,
              (SELECT m.body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
         FROM tickets t
         JOIN users u ON u.id = t.user_id
        WHERE ($1::text IS NULL OR t.status = $1)
          AND ($2::text IS NULL OR t.subject ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%')
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT $3`,
      [status, q || null, MAX_LIST]
    );
    res.json({ success: true, tickets: result.rows });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// GET /api/admin/tickets/:id — detail + full thread + owner
router.get('/tickets/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const ticket = await pool.query(
      `SELECT t.*, u.email, u.name FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [id]
    );
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const messages = await pool.query(
      'SELECT id, user_id, is_admin, body, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id',
      [id]
    );
    res.json({ success: true, ticket: ticket.rows[0], messages: messages.rows });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/tickets/:id/messages — admin reply (status → answered)
router.post('/tickets/:id/messages', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const body = String(req.body.body || '').trim();
    if (!body || body.length > 4000) return res.status(400).json({ error: 'Message required (max 4000 chars)' });

    const out = await withTransaction(async (client) => {
      const ticket = await client.query('SELECT id, status FROM tickets WHERE id = $1 FOR UPDATE', [id]);
      if (ticket.rows.length === 0) return null;
      if (ticket.rows[0].status === 'closed') throw Object.assign(new Error('closed'), { status: 409 });
      const message = await client.query(
        'INSERT INTO ticket_messages (ticket_id, user_id, is_admin, body) VALUES ($1, $2, true, $3) RETURNING *',
        [id, req.user.id, body]
      );
      const updated = await client.query(
        `UPDATE tickets SET status = 'answered', updated_at = now() WHERE id = $1 RETURNING *`,
        [id]
      );
      return { message: message.rows[0], ticket: updated.rows[0] };
    });
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.status(201).json({ success: true, message: out.message, ticket: out.ticket });
  } catch (err) {
    if (err && err.status === 409) return res.status(409).json({ error: 'Ticket is closed' });
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/tickets/:id/status — { status: open|closed } (reopen/close)
router.post('/tickets/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const status = String(req.body.status || '');
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const updated = await withTransaction(async (client) => {
      const cur = await client.query('SELECT status FROM tickets WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) return null;
      const next = await client.query(
        'UPDATE tickets SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [status, id]
      );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'ticket.status', targetType: 'ticket', targetId: id,
        payload: { from: cur.rows[0].status, to: status },
      });
      return next.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, ticket: updated });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// ===========================================================================
// Workers
// ===========================================================================

// GET /api/admin/workers
const WORKER_FILTERS = ['all', 'online', 'offline', 'removed'];

// GET /api/admin/workers?q=&status=all|online|offline|removed
// Each worker with its owner and what it earned, split by source (plan
// share / wallet / token bundle), all-time and last 30 days, plus totals
// across the whole (filtered) list.
router.get('/workers', authenticate, requireAdmin, async (req, res) => {
  try {
    const status = WORKER_FILTERS.includes(req.query.status) ? req.query.status : 'all';
    const where = [];
    const params = [];
    const text = String(req.query.q || '').trim().slice(0, 100);
    if (text) {
      const asId = parseId(text.replace(/^#/, ''));
      params.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      const like = `$${params.length}`;
      if (asId) {
        params.push(asId);
        where.push(`(u.email ILIKE ${like} OR m.name ILIKE ${like} OR m.id = $${params.length})`);
      } else {
        where.push(`(u.email ILIKE ${like} OR m.name ILIKE ${like})`);
      }
    }
    if (status === 'online') where.push("m.status IN ('online', 'busy')");
    else if (status === 'offline') where.push("(m.status IS NULL OR m.status = 'offline')");
    else if (status === 'removed') where.push("m.status = 'removed'");
    params.push(MAX_LIST);
    const result = await pool.query(
      `SELECT m.id, m.name, m.user_id, m.status, m.gpu_model, m.ram, m.current_model, m.models,
              m.total_tasks, m.earnings, m.last_seen, m.created_at, m.app_version, m.wallet_address,
              u.email,
              COALESCE(e.plan_all, 0) AS earned_plan, COALESCE(e.wallet_all, 0) AS earned_wallet,
              COALESCE(e.tokens_all, 0) AS earned_tokens, COALESCE(e.total_30d, 0) AS earned_30d
         FROM workers m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN LATERAL (
              SELECT SUM(amount) FILTER (WHERE source = 'plan') AS plan_all,
                     SUM(amount) FILTER (WHERE source = 'wallet') AS wallet_all,
                     SUM(amount) FILTER (WHERE source = 'tokens') AS tokens_all,
                     SUM(amount) FILTER (WHERE created_at >= now() - interval '30 days') AS total_30d
                FROM worker_coin_earnings ce
               WHERE ce.worker_id = m.id AND ce.coin = 'USD'
         ) e ON true
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.earnings DESC NULLS LAST, m.id DESC
        LIMIT $${params.length}`,
      params
    );
    const n = (v) => Number(v) || 0;
    const summary = result.rows.reduce((acc, r) => ({
      total: acc.total + n(r.earnings),
      last_30d: acc.last_30d + n(r.earned_30d),
      plan: acc.plan + n(r.earned_plan),
      wallet: acc.wallet + n(r.earned_wallet),
      tokens: acc.tokens + n(r.earned_tokens),
    }), { total: 0, last_30d: 0, plan: 0, wallet: 0, tokens: 0 });
    res.json({ success: true, workers: result.rows, summary, status });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// PUT /api/admin/workers/:id/status — { status: removed|offline }
// remove marks it gone (same as uninstall); restore puts it back offline.
router.put('/workers/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const status = String(req.body.status || '');
    if (!WORKER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const updated = await withTransaction(async (client) => {
      const cur = await client.query('SELECT status FROM workers WHERE id = $1 FOR UPDATE', [id]);
      if (cur.rows.length === 0) return null;
      const next = status === 'removed'
        ? await client.query(
            `UPDATE workers SET status = 'removed', uninstalled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 RETURNING id, status`,
            [id]
          )
        : await client.query(
            `UPDATE workers SET status = 'offline', uninstalled_at = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 RETURNING id, status`,
            [id]
          );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'worker.status', targetType: 'worker', targetId: id,
        payload: { from: cur.rows[0].status, to: status },
      });
      return next.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, worker: updated });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// ===========================================================================
// Global money views (read-only)
// ===========================================================================

// GET /api/admin/payments — all deposits + withdrawals (with owner email)
router.get('/payments', authenticate, requireAdmin, async (req, res) => {
  try {
    const [deposits, withdrawals] = await Promise.all([
      pool.query(
        `SELECT d.*, u.email FROM coin_deposits d LEFT JOIN users u ON u.id = d.user_id
          ORDER BY d.created_at DESC LIMIT $1`,
        [MAX_LIST]
      ),
      pool.query(
        `SELECT w.*, u.email FROM coin_withdrawals w LEFT JOIN users u ON u.id = w.user_id
          ORDER BY w.created_at DESC LIMIT $1`,
        [MAX_LIST]
      ),
    ]);
    res.json({ success: true, deposits: deposits.rows, withdrawals: withdrawals.rows });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// GET /api/admin/purchases — all plan/token purchases (with owner email)
router.get('/purchases', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.email FROM plan_purchases p LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.created_at DESC LIMIT $1`,
      [MAX_LIST]
    );
    res.json({ success: true, purchases: result.rows });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// ===========================================================================
// Tasks (read-only)
// ===========================================================================

// GET /api/admin/tasks
router.get('/tasks', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, u.email as user_email FROM tasks t LEFT JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC LIMIT 100'
    );
    res.json({ success: true, tasks: result.rows });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// ===========================================================================
// Orgs (v3.44.0) — admin creates orgs (name + leader), manages members,
// disbands. Every mutation writes admin_audit_log in the same transaction.
// ===========================================================================

// GET /api/admin/orgs — list orgs with members + leader email.
router.get('/orgs', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.name, o.status, o.created_at, o.leader_user_id,
              u.email AS leader_email
         FROM orgs o LEFT JOIN users u ON u.id = o.leader_user_id
        ORDER BY o.created_at DESC LIMIT ${MAX_LIST}`
    );
    const members = await pool.query(
      `SELECT m.org_id, m.user_id, u.email, m.role, m.joined_at
         FROM org_members m JOIN users u ON u.id = m.user_id
        WHERE m.status = 'active' AND m.org_id = ANY($1)
        ORDER BY m.joined_at ASC`,
      [result.rows.map((r) => r.id)]
    );
    const byOrg = {};
    for (const m of members.rows) {
      (byOrg[m.org_id] = byOrg[m.org_id] || []).push(m);
    }
    res.json({
      success: true,
      orgs: result.rows.map((o) => ({ ...o, members: byOrg[o.id] || [] })),
    });
  } catch (err) {
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/orgs — { name, leader_email } — create org + leader row.
router.post('/orgs', authenticate, requireAdmin, async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    const email = typeof req.body.leader_email === 'string' ? req.body.leader_email.trim().toLowerCase() : '';
    if (!name) return res.status(400).json({ error: 'Org name required (max 100 chars)' });
    if (!email) return res.status(400).json({ error: 'Leader email required' });
    const out = await withTransaction(async (client) => {
      const leader = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if (leader.rows.length === 0) throw Object.assign(new Error('No registered user with that email'), { status: 404 });
      const lid = leader.rows[0].id;
      const busy = await client.query(`SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'active'`, [lid]);
      if (busy.rows.length > 0) throw Object.assign(new Error('Leader already belongs to an active org'), { status: 400 });
      const org = await client.query(
        `INSERT INTO orgs (name, leader_user_id, status) VALUES ($1, $2, 'active') RETURNING id, name`,
        [name, lid]
      );
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'leader', 'active')`,
        [org.rows[0].id, lid]
      );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'org.create', targetType: 'org', targetId: org.rows[0].id,
        reason: req.body.reason, payload: { name, leader_email: email },
      });
      return org.rows[0];
    });
    res.status(201).json({ success: true, org: out });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/orgs/:id/members — { email } — add a registered user.
router.post('/orgs/:id/members', authenticate, requireAdmin, async (req, res) => {
  try {
    const orgId = parseId(req.params.id);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!orgId) return res.status(400).json({ error: 'Org id is required' });
    if (!email) return res.status(400).json({ error: 'Email required' });
    const out = await withTransaction(async (client) => {
      const org = await client.query(`SELECT id, status FROM orgs WHERE id = $1`, [orgId]);
      if (org.rows.length === 0 || org.rows[0].status !== 'active') {
        throw Object.assign(new Error('Org not found'), { status: 404 });
      }
      const user = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if (user.rows.length === 0) throw Object.assign(new Error('No registered user with that email'), { status: 404 });
      const busy = await client.query(`SELECT org_id FROM org_members WHERE user_id = $1 AND status = 'active'`, [user.rows[0].id]);
      if (busy.rows.length > 0) throw Object.assign(new Error('User already belongs to an active org'), { status: 400 });
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')
         ON CONFLICT (org_id, user_id) DO UPDATE SET status = 'active', role = 'member'`,
        [orgId, user.rows[0].id]
      );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'org.member.add', targetType: 'org', targetId: orgId,
        reason: req.body.reason, payload: { email },
      });
      return { added: user.rows[0].id };
    });
    res.status(201).json({ success: true, ...out });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    fail(res, err, 'Admin route failed');
  }
});

// DELETE /api/admin/orgs/:id/members/:userId — remove a member (not the leader).
router.delete('/orgs/:id/members/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    const orgId = parseId(req.params.id);
    const target = parseId(req.params.userId);
    if (!orgId || !target) return res.status(400).json({ error: 'Org id and user id are required' });
    const out = await withTransaction(async (client) => {
      const org = await client.query(`SELECT leader_user_id FROM orgs WHERE id = $1`, [orgId]);
      if (org.rows.length === 0) throw Object.assign(new Error('Org not found'), { status: 404 });
      if (org.rows[0].leader_user_id === target) {
        throw Object.assign(new Error('Transfer leadership first (or disband)'), { status: 400 });
      }
      await client.query(`UPDATE org_members SET status = 'removed' WHERE org_id = $1 AND user_id = $2`, [orgId, target]);
      await logAdminAction(client, {
        adminId: req.user.id, action: 'org.member.remove', targetType: 'org', targetId: orgId,
        reason: req.body && req.body.reason, payload: { user_id: target },
      });
      return { removed: target };
    });
    res.json({ success: true, ...out });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    fail(res, err, 'Admin route failed');
  }
});

// POST /api/admin/orgs/:id/disband — close the org (members fall back to own plans).
router.post('/orgs/:id/disband', authenticate, requireAdmin, async (req, res) => {
  try {
    const orgId = parseId(req.params.id);
    if (!orgId) return res.status(400).json({ error: 'Org id is required' });
    await withTransaction(async (client) => {
      const upd = await client.query(`UPDATE orgs SET status = 'disbanded' WHERE id = $1 AND status = 'active' RETURNING id`, [orgId]);
      if (upd.rows.length === 0) throw Object.assign(new Error('Org not found'), { status: 404 });
      await client.query(`UPDATE org_members SET status = 'removed' WHERE org_id = $1`, [orgId]);
      await logAdminAction(client, {
        adminId: req.user.id, action: 'org.disband', targetType: 'org', targetId: orgId,
        reason: req.body.reason, payload: null,
      });
    });
    res.json({ success: true, disbanded: orgId });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    fail(res, err, 'Admin route failed');
  }
});

module.exports = router;
