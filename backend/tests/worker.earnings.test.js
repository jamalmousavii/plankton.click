// GET /api/workers/mine/:id/earnings (v3.41.3): per-worker lifetime +
// 5-way breakdown for active AND removed workers, owner-only.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/database/pool', () => {
  const state = { queryImpl: async () => ({ rows: [] }) };
  return {
    __state: state,
    query: (sql, params) => state.queryImpl(sql, params),
    connect: async () => { throw new Error('connectImpl not scripted'); },
  };
});

const pool = require('../src/database/pool');
const workerRoutes = require('../src/routes/workers');

const SECRET = process.env.JWT_SECRET;
const sign = (id) => jwt.sign({ id, role: 'user', token_version: 0 }, SECRET, {
  algorithm: 'HS256',
  expiresIn: '1h',
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/workers', workerRoutes);
  return app;
}

// ownerId: the worker row's user_id. earningRows: worker_coin_earnings rows.
function scriptDb({ ownerId = 7, earningRows = [] } = {}) {
  pool.__state.queryImpl = async (sql) => {
    if (String(sql).includes('token_version')) return { rows: [{ token_version: 0, banned: false }] };
    if (String(sql).includes('FROM workers WHERE id = $1')) {
      return {
        rows: [{
          id: 9, user_id: ownerId, name: 'h1', status: 'removed',
          total_tasks: 12, earnings: 3.5,
          created_at: '2026-01-01', last_seen: '2026-02-01', uninstalled_at: '2026-03-01',
        }],
      };
    }
    if (String(sql).includes('FROM worker_coin_earnings')) return { rows: earningRows };
    return { rows: [] };
  };
}

describe('GET /api/workers/mine/:id/earnings', () => {
  const app = buildApp();

  it('returns lifetime + 5-way breakdown for a removed worker of mine', async () => {
    scriptDb({
      ownerId: 7,
      earningRows: [
        { source: 'tokens', plan_type: 'free', amount: '1.00' },
        // A Pro subscriber paying from the wallet is still a wallet earning;
        // only source 'plan' (subscription revenue share) lands in Pro.
        { source: 'wallet', plan_type: 'pro', amount: '2.00' },
        { source: 'wallet', plan_type: 'free', amount: '0.50' },
        { source: 'plan', plan_type: 'pro', amount: '0.75' },
      ],
    });
    const res = await request(app)
      .get('/api/workers/mine/9/earnings')
      .set('Authorization', `Bearer ${sign(7)}`);
    expect(res.status).toBe(200);
    expect(res.body.worker).toMatchObject({ id: 9, name: 'h1', status: 'removed', total_tasks: 12 });
    expect(res.body.worker).not.toHaveProperty('user_id');
    expect(res.body.worker).not.toHaveProperty('worker_token');
    expect(res.body.breakdown).toEqual({ tokens: 1, wallet: 2.5, plus: 0, pro: 0.75, max: 0 });
  });

  it('404s someone else\u2019s worker (existence-hiding)', async () => {
    scriptDb({ ownerId: 8, earningRows: [] });
    const res = await request(app)
      .get('/api/workers/mine/9/earnings')
      .set('Authorization', `Bearer ${sign(7)}`);
    expect(res.status).toBe(404);
  });

  it('400s a non-numeric id', async () => {
    scriptDb();
    const res = await request(app)
      .get('/api/workers/mine/abc/earnings')
      .set('Authorization', `Bearer ${sign(7)}`);
    expect(res.status).toBe(400);
  });

  it('401s without a token', async () => {
    scriptDb();
    const res = await request(app).get('/api/workers/mine/9/earnings');
    expect(res.status).toBe(401);
  });
});
