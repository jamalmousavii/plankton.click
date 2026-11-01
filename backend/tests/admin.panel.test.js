// Admin panel: user search + type filter, per-user usage, plan change (incl.
// downgrade / back to Free), worker earnings by source.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/database/pool', () => {
  const state = { statements: [], params: [], queryImpl: async () => ({ rows: [] }) };
  const norm = (sql) => String(sql).trim().replace(/\s+/g, ' ');
  const run = (sql, params) => {
    state.statements.push(norm(sql));
    state.params.push(params);
    return state.queryImpl(sql, params);
  };
  return { __state: state, query: run, connect: async () => ({ query: run, release: () => {} }) };
});

const pool = require('../src/database/pool');
const adminRouter = require('../src/routes/admin');

const ADMIN = jwt.sign({ id: 11, role: 'admin', token_version: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', adminRouter);
  return a;
}

// Auth/role lookups every admin request makes; `extra` answers the rest.
function db(extra) {
  pool.__state.queryImpl = async (sql, params) => {
    if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
    return (extra && (await extra(sql, params))) || { rows: [] };
  };
}

const last = (re) => {
  const i = pool.__state.statements.map((s, k) => (re.test(s) ? k : -1)).filter((k) => k >= 0).pop();
  return i === undefined ? null : { sql: pool.__state.statements[i], params: pool.__state.params[i] };
};

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.params.length = 0;
});

describe('GET /api/admin/users search + filter', () => {
  it('searches email/name and also matches #id', async () => {
    db();
    const res = await request(app()).get('/api/admin/users?q=%2342').set('Authorization', `Bearer ${ADMIN}`);
    expect(res.status).toBe(200);
    const q = last(/FROM users u/);
    expect(q.sql).toMatch(/u\.email ILIKE \$1 OR u\.name ILIKE \$1 OR u\.id = \$2/);
    expect(q.params.slice(0, 2)).toEqual(['%#42%', 42]);
  });

  it('escapes LIKE wildcards in the search text', async () => {
    db();
    await request(app()).get('/api/admin/users?q=a%25_b').set('Authorization', `Bearer ${ADMIN}`);
    expect(last(/FROM users u/).params[0]).toBe('%a\\%\\_b%');
  });

  it('filters workers vs plain users', async () => {
    db();
    await request(app()).get('/api/admin/users?type=worker').set('Authorization', `Bearer ${ADMIN}`);
    expect(last(/FROM users u/).sql).toMatch(/WHERE COALESCE\(w\.worker_count, 0\) > 0/);
    await request(app()).get('/api/admin/users?type=user').set('Authorization', `Bearer ${ADMIN}`);
    expect(last(/FROM users u/).sql).toMatch(/COALESCE\(w\.worker_count, 0\) = 0 AND u\.role <> 'admin'/);
    const res = await request(app()).get('/api/admin/users?type=nonsense').set('Authorization', `Bearer ${ADMIN}`);
    expect(res.body.type).toBe('all');
  });

  it('returns usage columns', async () => {
    db(async (sql) => (/FROM users u/.test(sql)
      ? { rows: [{ id: 5, email: 'a@b.c', worker_count: 2, tokens_today: '1200', tokens_30d: '9000', spend_30d: '0.01', messages_30d: 4 }] }
      : null));
    const res = await request(app()).get('/api/admin/users').set('Authorization', `Bearer ${ADMIN}`);
    expect(res.body.users[0]).toMatchObject({ worker_count: 2, tokens_30d: '9000', messages_30d: 4 });
  });
});

describe('GET /api/admin/users/:id/usage', () => {
  it('returns per-day, per-model (with weight) and today vs cap', async () => {
    db(async (sql) => {
      if (/SELECT id, email FROM users WHERE id/.test(sql)) return { rows: [{ id: 5, email: 'a@b.c' }] };
      if (/GROUP BY 1 ORDER BY 1 DESC/.test(sql)) return { rows: [{ day: '2026-11-01', messages: 3, tokens: '3000', cost: '0.0001' }] };
      if (/GROUP BY model/.test(sql)) return { rows: [{ model: 'llama3.3:70b', messages: 1, tokens: '100', cost: '0.00003' }] };
      if (/FROM daily_tokens/.test(sql)) return { rows: [{ used: '1000' }] };
      return null;
    });
    const res = await request(app()).get('/api/admin/users/5/usage').set('Authorization', `Bearer ${ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.today).toEqual({ used: 1000, cap: 2000000 });
    expect(res.body.by_day).toHaveLength(1);
    expect(res.body.by_model[0]).toMatchObject({ model: 'llama3.3:70b', token_weight: 10 });
  });

  it('404s for an unknown user', async () => {
    db();
    const res = await request(app()).get('/api/admin/users/999/usage').set('Authorization', `Bearer ${ADMIN}`);
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/admin/users/:id/plan (set, not just grant)', () => {
  const plansDb = () => db(async (sql) => {
    if (/SELECT id FROM users WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [{ id: 5 }] };
    if (/user_id = \$1 AND plan_type = \$2 AND status/.test(sql)) {
      return { rows: [{ plan_type: 'plus', expires_at: '2026-12-01T00:00:00.000Z' }] };
    }
    return null;
  });

  it('downgrades: cancels the other active tiers, then sets the chosen one for N days', async () => {
    plansDb();
    const res = await request(app()).put('/api/admin/users/5/plan')
      .set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'plus', days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.plan.plan_type).toBe('plus');
    expect(last(/UPDATE user_plans SET status = 'cancelled'/).params).toEqual([5, 'plus']);
    expect(last(/INSERT INTO user_plans/).params).toEqual([5, 'plus', 7]);
    expect(last(/INSERT INTO admin_audit_log/).params[5]).toMatch(/"days":7/);
  });

  it('free removes every active plan and inserts nothing', async () => {
    plansDb();
    const res = await request(app()).put('/api/admin/users/5/plan')
      .set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'free' });
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeNull();
    expect(last(/UPDATE user_plans SET status = 'cancelled'/).params).toEqual([5, 'free']);
    expect(last(/INSERT INTO user_plans/)).toBeNull();
  });

  it('validates tier and days', async () => {
    plansDb();
    const bad = await request(app()).put('/api/admin/users/5/plan').set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'gold' });
    expect(bad.status).toBe(400);
    const badDays = await request(app()).put('/api/admin/users/5/plan').set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'pro', days: 0 });
    expect(badDays.status).toBe(400);
    const defDays = await request(app()).put('/api/admin/users/5/plan').set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'pro' });
    expect(defDays.status).toBe(200);
    expect(last(/INSERT INTO user_plans/).params).toEqual([5, 'pro', 30]);
  });
});

describe('GET /api/admin/workers earnings', () => {
  it('splits earnings by source and totals them', async () => {
    db(async (sql) => (/FROM workers m/.test(sql)
      ? {
        rows: [
          { id: 1, earnings: '1.5', earned_plan: '0.5', earned_wallet: '0.75', earned_tokens: '0.25', earned_30d: '1.0' },
          { id: 2, earnings: '0.5', earned_plan: '0.5', earned_wallet: '0', earned_tokens: '0', earned_30d: '0.5' },
        ],
      }
      : null));
    const res = await request(app()).get('/api/admin/workers?status=online&q=gpu').set('Authorization', `Bearer ${ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 2, last_30d: 1.5, plan: 1, wallet: 0.75, tokens: 0.25 });
    const q = last(/FROM workers m/);
    expect(q.sql).toMatch(/m\.status IN \('online', 'busy'\)/);
    expect(q.sql).toMatch(/source = 'plan'/);
  });
});
