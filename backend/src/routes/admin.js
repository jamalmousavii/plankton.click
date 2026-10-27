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
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.banned, u.created_at,
              COALESCE(cb.available, 0) AS usd_balance,
              COALESCE(tb.tokens, 0) AS token_balance,
              up.plan_type AS active_plan, up.expires_at AS plan_expires_at
         FROM users u
         LEFT JOIN user_coin_balances cb ON cb.user_id = u.id AND cb.coin = 'USD'
         LEFT JOIN user_token_balances tb ON tb.user_id = u.id
         LEFT JOIN LATERAL (
              SELECT plan_type, expires_at FROM user_plans p
               WHERE p.user_id = u.id AND p.status = 'active' AND p.expires_at > now()
               ORDER BY p.expires_at DESC LIMIT 1
         ) up ON true
        ORDER BY u.created_at DESC
        LIMIT $1`,
      [MAX_LIST]
    );
    res.json({ success: true, users: result.rows });
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

// PUT /api/admin/users/:id/plan — { plan: plus|pro|max } — grant/extend 30 days
router.put('/users/:id/plan', authenticate, requireAdmin, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Not found' });
    const plan = String(req.body.plan || '');
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan tier' });

    const updated = await withTransaction(async (client) => {
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (user.rows.length === 0) return null;
      await activatePlan(id, plan, client);
      const after = await client.query(
        `SELECT plan_type, expires_at FROM user_plans
          WHERE user_id = $1 AND plan_type = $2 AND status = 'active'`,
        [id, plan]
      );
      await logAdminAction(client, {
        adminId: req.user.id, action: 'user.plan', targetType: 'user', targetId: id,
        payload: { plan, interval_days: PLANS[plan].interval_days },
      });
      return after.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, plan: updated });
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
router.get('/workers', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.email FROM workers m
         LEFT JOIN users u ON u.id = m.user_id
        ORDER BY m.earnings DESC LIMIT $1`,
      [MAX_LIST]
    );
    res.json({ success: true, workers: result.rows });
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
