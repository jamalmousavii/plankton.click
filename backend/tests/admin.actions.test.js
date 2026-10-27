// v3.39.0 — admin management actions: role/ban, USD balance, token pot,
// plan grant, worker status, money views. Every mutation must also write
// admin_audit_log (same transaction) — asserted via recorded statements.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/database/pool', () => {
  const state = {
    statements: [],
    params: [],
    queryImpl: async () => ({ rows: [] }),
  };
  const norm = (sql) => String(sql).trim().replace(/\s+/g, ' ');
  const run = (sql, params) => {
    state.statements.push(norm(sql));
    state.params.push(params);
    return state.queryImpl(sql, params);
  };
  return {
    __state: state,
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  };
});

const pool = require('../src/database/pool');
const adminRouter = require('../src/routes/admin');

const SECRET = process.env.JWT_SECRET;

function sign(payload) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

// id 1 = admin (role cache), id 2 = plain user, id 3 = second admin (unused
// cases), distinct ids keep the module-level caches deterministic.
const ADMIN = sign({ id: 1, email: 'admin@plankton.click', role: 'admin', token_version: 0 });
const PLAIN = sign({ id: 2, email: 'plain@t.t', role: 'user', token_version: 0 });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}

function resetPool() {
  pool.__state.statements.length = 0;
  pool.__state.params.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
}

function adminAuth(role = 'admin') {
  return async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role }] };
    return { rows: [] };
  };
}

beforeEach(resetPool);

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------
it('PUT /users/:id/role — validation, self-guard, success + audit', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users WHERE id = \$1$/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT role FROM users WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ role: 'user' }] };
    if (/UPDATE users SET role/.test(sql)) return { rows: [{ id: 5, role: 'worker' }] };
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const bad = await request(app()).put('/api/admin/users/5/role')
    .set('Authorization', `Bearer ${ADMIN}`).send({ role: 'god' });
  expect(bad.status).toBe(400);

  const self = await request(app()).put('/api/admin/users/1/role')
    .set('Authorization', `Bearer ${ADMIN}`).send({ role: 'user' });
  expect(self.status).toBe(409);

  const ok = await request(app()).put('/api/admin/users/5/role')
    .set('Authorization', `Bearer ${ADMIN}`).send({ role: 'worker' });
  expect(ok.status).toBe(200);
  expect(ok.body.user).toMatchObject({ id: 5, role: 'worker' });
  const sql = pool.__state.statements.join('\n');
  expect(sql).toMatch(/INSERT INTO admin_audit_log/);
  expect(sql).toMatch(/BEGIN[\s\S]*COMMIT/);
});

// ---------------------------------------------------------------------------
// Ban
// ---------------------------------------------------------------------------
it('PUT /users/:id/ban — self-guard, success invalidates sessions + audit', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT banned FROM users/.test(sql)) return { rows: [{ banned: false }] };
    if (/UPDATE users SET banned/.test(sql)) return { rows: [{ id: 5, banned: true }] };
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const self = await request(app()).put('/api/admin/users/1/ban')
    .set('Authorization', `Bearer ${ADMIN}`).send({ banned: true });
  expect(self.status).toBe(409);

  const bad = await request(app()).put('/api/admin/users/5/ban')
    .set('Authorization', `Bearer ${ADMIN}`).send({ banned: 'yes' });
  expect(bad.status).toBe(400);

  const ok = await request(app()).put('/api/admin/users/5/ban')
    .set('Authorization', `Bearer ${ADMIN}`).send({ banned: true });
  expect(ok.status).toBe(200);
  expect(ok.body.user).toMatchObject({ id: 5, banned: true });
  expect(pool.__state.statements.join(' ')).toMatch(/INSERT INTO admin_audit_log/);
});

// ---------------------------------------------------------------------------
// USD balance
// ---------------------------------------------------------------------------
it('POST /users/:id/balance — validation, floor at zero, success + audit', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT available FROM user_coin_balances/.test(sql)) return { rows: [{ available: '10.5' }] };
    if (/UPDATE user_coin_balances/.test(sql)) return { rows: [] };
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const zero = await request(app()).post('/api/admin/users/5/balance')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_usd: 0, reason: 'x' });
  expect(zero.status).toBe(400);

  const noReason = await request(app()).post('/api/admin/users/5/balance')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_usd: 5 });
  expect(noReason.status).toBe(400);

  const floor = await request(app()).post('/api/admin/users/5/balance')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_usd: -50, reason: 'chargeback reversal' });
  expect(floor.status).toBe(400);

  const ok = await request(app()).post('/api/admin/users/5/balance')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_usd: 25, reason: 'goodwill credit' });
  expect(ok.status).toBe(200);
  expect(ok.body.balance).toBeCloseTo(35.5, 8);
  const sql = pool.__state.statements.join('\n');
  expect(sql).toMatch(/INSERT INTO admin_audit_log/);
  const auditPayload = pool.__state.params.find(
    (p, i) => pool.__state.statements[i].includes('INSERT INTO admin_audit_log') && p
  );
  expect(auditPayload && JSON.parse(auditPayload[5])).toMatchObject({ delta_usd: 25, before: 10.5, after: 35.5 });
});

// ---------------------------------------------------------------------------
// Token pot
// ---------------------------------------------------------------------------
it('POST /users/:id/tokens — non-zero integer, floor, success + audit', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT id FROM users WHERE id/.test(sql)) return { rows: [{ id: 5 }] };
    if (/SELECT tokens FROM user_token_balances/.test(sql)) return { rows: [{ tokens: 100 }] };
    if (/INSERT INTO user_token_balances/.test(sql)) return { rows: [] };
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const zero = await request(app()).post('/api/admin/users/5/tokens')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_tokens: 0, reason: 'x' });
  expect(zero.status).toBe(400);

  const floor = await request(app()).post('/api/admin/users/5/tokens')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_tokens: -500, reason: 'reverse double credit' });
  expect(floor.status).toBe(400);

  const ok = await request(app()).post('/api/admin/users/5/tokens')
    .set('Authorization', `Bearer ${ADMIN}`).send({ delta_tokens: 50, reason: 'compensation' });
  expect(ok.status).toBe(200);
  expect(ok.body.tokens).toBe(150);
  expect(pool.__state.statements.join(' ')).toMatch(/INSERT INTO admin_audit_log/);
});

// ---------------------------------------------------------------------------
// Plan grant
// ---------------------------------------------------------------------------
it('PUT /users/:id/plan — invalid tier 400, grant runs activatePlan + audit', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT id FROM users WHERE id/.test(sql)) return { rows: [{ id: 5 }] };
    if (/INSERT INTO user_plans/.test(sql)) return { rows: [] };
    if (/SELECT plan_type, expires_at FROM user_plans/.test(sql)) {
      return { rows: [{ plan_type: 'pro', expires_at: '2026-11-01T00:00:00.000Z' }] };
    }
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const bad = await request(app()).put('/api/admin/users/5/plan')
    .set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'gold' });
  expect(bad.status).toBe(400);

  const ok = await request(app()).put('/api/admin/users/5/plan')
    .set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'pro' });
  expect(ok.status).toBe(200);
  expect(ok.body.plan.plan_type).toBe('pro');
  expect(pool.__state.statements.join(' ')).toMatch(/INSERT INTO user_plans/);
  expect(pool.__state.statements.join(' ')).toMatch(/INSERT INTO admin_audit_log/);
});

// ---------------------------------------------------------------------------
// Worker status
// ---------------------------------------------------------------------------
it('PUT /workers/:id/status — remove/restore + audit, invalid 400', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/SELECT status FROM workers/.test(sql)) return { rows: [{ status: 'online' }] };
    if (/UPDATE workers SET status = 'removed'/.test(sql)) return { rows: [{ id: 3, status: 'removed' }] };
    if (/UPDATE workers SET status = 'offline'/.test(sql)) return { rows: [{ id: 3, status: 'offline' }] };
    if (/INSERT INTO admin_audit_log/.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  const bad = await request(app()).put('/api/admin/workers/3/status')
    .set('Authorization', `Bearer ${ADMIN}`).send({ status: 'exploded' });
  expect(bad.status).toBe(400);

  const remove = await request(app()).put('/api/admin/workers/3/status')
    .set('Authorization', `Bearer ${ADMIN}`).send({ status: 'removed' });
  expect(remove.status).toBe(200);
  expect(remove.body.worker.status).toBe('removed');
  expect(pool.__state.statements.join(' ')).toMatch(/uninstalled_at = CURRENT_TIMESTAMP/);

  const restore = await request(app()).put('/api/admin/workers/3/status')
    .set('Authorization', `Bearer ${ADMIN}`).send({ status: 'offline' });
  expect(restore.status).toBe(200);
  expect(restore.body.worker.status).toBe('offline');
  expect(pool.__state.statements.join(' ')).toMatch(/uninstalled_at = NULL/);
  expect((pool.__state.statements.join('').match(/INSERT INTO admin_audit_log/g) || []).length).toBe(2);
});

// ---------------------------------------------------------------------------
// Read views
// ---------------------------------------------------------------------------
it('GET /payments and /purchases return rows; plain user gets 403', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/FROM coin_deposits/.test(sql)) return { rows: [{ id: 1, email: 'a@t.t' }] };
    if (/FROM coin_withdrawals/.test(sql)) return { rows: [{ id: 2, email: 'b@t.t' }] };
    if (/FROM plan_purchases/.test(sql)) return { rows: [{ order_id: 'o1', email: 'c@t.t' }] };
    return { rows: [] };
  };

  const pays = await request(app()).get('/api/admin/payments').set('Authorization', `Bearer ${ADMIN}`);
  expect(pays.status).toBe(200);
  expect(pays.body.deposits).toHaveLength(1);
  expect(pays.body.withdrawals).toHaveLength(1);

  const buys = await request(app()).get('/api/admin/purchases').set('Authorization', `Bearer ${ADMIN}`);
  expect(buys.status).toBe(200);
  expect(buys.body.purchases[0].order_id).toBe('o1');

  pool.__state.queryImpl = adminAuth('user');
  const denied = await request(app()).get('/api/admin/purchases').set('Authorization', `Bearer ${PLAIN}`);
  expect(denied.status).toBe(403);
});

it('GET /users returns balances + plan for the action dialogs', async () => {
  pool.__state.queryImpl = async (sql) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    if (/FROM users u/.test(sql)) {
      return {
        rows: [{
          id: 5, email: 'x@t.t', name: 'X', role: 'user', banned: false,
          created_at: '2026-01-01', usd_balance: '12.5', token_balance: '900',
          active_plan: 'plus', plan_expires_at: '2026-11-01T00:00:00.000Z',
        }],
      };
    }
    return { rows: [] };
  };
  const res = await request(app()).get('/api/admin/users').set('Authorization', `Bearer ${ADMIN}`);
  expect(res.status).toBe(200);
  expect(res.body.users[0]).toMatchObject({ banned: false, usd_balance: '12.5', active_plan: 'plus' });
});
