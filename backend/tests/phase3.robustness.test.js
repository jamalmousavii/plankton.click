// Phase 3 (v3.33.0) — robustness tests: B4 pending-row-first ordering,
// B6 disconnect rejection, B10 leaderboard source.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/database/pool', () => {
  const state = {
    statements: [],
    queryImpl: async () => ({ rows: [] }),
    connectImpl: async () => { throw new Error('connectImpl not scripted'); },
  };
  const push = (sql) => state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
  return {
    __state: state,
    query: (sql, params) => { push(sql); return state.queryImpl(sql, params, push); },
    connect: () => state.connectImpl(push),
  };
});

jest.mock('../src/services/nowpayments', () => ({
  createInvoice: jest.fn(),
  getMinUsdDeposit: () => 1,
  getSupportedCoins: () => ({}),
  verifyIPN: jest.fn(),
  processIPN: jest.fn(),
  getWithdrawFee: () => 0.5,
}));

const pool = require('../src/database/pool');
const nowpayments = require('../src/services/nowpayments');

const SECRET = process.env.JWT_SECRET;
const sign = (payload) => jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

// authenticate only checks the token_version claim against this.
function authDb() {
  pool.__state.queryImpl = async (sql) => {
    if (String(sql).includes('token_version')) return { rows: [{ token_version: 0 }] };
    return { rows: [] };
  };
}

function plansApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/plans', require('../src/routes/plans'));
  return app;
}

function paymentsApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', require('../src/routes/payments'));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
  pool.__state.connectImpl = async () => { throw new Error('connectImpl not scripted'); };
});

// ---------------------------------------------------------------------------
// B4 — the pending row must be written BEFORE the invoice exists.
// ---------------------------------------------------------------------------
describe('B4: pending row before invoice', () => {
  it('inserts the token-bundle row first, then creates the invoice', async () => {
    const events = [];
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.startsWith('INSERT INTO plan_purchases')) events.push('insert');
      if (s.includes('SET invoice_id')) events.push('store-invoice');
      return { rows: [] };
    };
    nowpayments.createInvoice.mockImplementation(async () => {
      events.push('invoice');
      return { success: true, invoiceId: 'INV1', invoiceUrl: 'https://pay.example' };
    });

    const token = sign({ id: 301, role: 'user', token_version: 0 });
    const res = await request(plansApp())
      .post('/api/plans/tokens/purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 5 });

    expect(res.status).toBe(201);
    expect(events).toEqual(['insert', 'invoice', 'store-invoice']);
    expect(res.body.invoice.order_id).toMatch(/^tok-301-/);
  });

  it('marks the row failed when invoice creation fails', async () => {
    const events = [];
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.startsWith('INSERT INTO plan_purchases')) events.push('insert');
      if (s.includes("status = 'failed'")) events.push('mark-failed');
      if (s.includes('SET invoice_id')) events.push('store-invoice');
      return { rows: [] };
    };
    nowpayments.createInvoice.mockImplementation(async () => {
      events.push('invoice');
      return { success: false, error: 'NowPayments down' };
    });

    const token = sign({ id: 302, role: 'user', token_version: 0 });
    const res = await request(plansApp())
      .post('/api/plans/tokens/purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 5 });

    expect(res.status).toBe(500);
    expect(events).toEqual(['insert', 'invoice', 'mark-failed']);
    expect(events).not.toContain('store-invoice');
  });

  it('inserts the plan-tier row before creating the invoice', async () => {
    const events = [];
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.startsWith('INSERT INTO plan_purchases')) events.push('insert');
      if (s.includes('SET invoice_id')) events.push('store-invoice');
      return { rows: [] };
    };
    nowpayments.createInvoice.mockImplementation(async () => {
      events.push('invoice');
      return { success: true, invoiceId: 'INV2', invoiceUrl: 'https://pay.example' };
    });

    const token = sign({ id: 303, role: 'user', token_version: 0 });
    const res = await request(plansApp())
      .post('/api/plans/plus/purchase')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(events).toEqual(['insert', 'invoice', 'store-invoice']);
  });

  it('inserts the deposit row before creating the invoice', async () => {
    const events = [];
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.startsWith('INSERT INTO coin_deposits')) events.push('insert');
      if (s.includes('SET processor_id')) events.push('store-invoice');
      return { rows: [] };
    };
    nowpayments.createInvoice.mockImplementation(async () => {
      events.push('invoice');
      return { success: true, invoiceId: 'INV3', invoiceUrl: 'https://pay.example', payAddress: 'addr', payAmount: 5 };
    });

    const token = sign({ id: 304, role: 'user', token_version: 0 });
    const res = await request(paymentsApp())
      .post('/api/payments/deposit/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 10 });

    expect(res.status).toBe(201);
    expect(events).toEqual(['insert', 'invoice', 'store-invoice']);
  });

  it('marks the deposit failed when invoice creation fails', async () => {
    const events = [];
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.startsWith('INSERT INTO coin_deposits')) events.push('insert');
      if (s.includes("status = 'failed'")) events.push('mark-failed');
      if (s.includes('SET processor_id')) events.push('store-invoice');
      return { rows: [] };
    };
    nowpayments.createInvoice.mockImplementation(async () => {
      events.push('invoice');
      return { success: false, error: 'NowPayments down' };
    });

    const token = sign({ id: 305, role: 'user', token_version: 0 });
    const res = await request(paymentsApp())
      .post('/api/payments/deposit/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 10 });

    expect(res.status).toBe(500);
    expect(events).toEqual(['insert', 'invoice', 'mark-failed']);
  });
});

// ---------------------------------------------------------------------------
// B6 — a disconnected worker must reject its in-flight tasks immediately.
// ---------------------------------------------------------------------------
const WSServer = require('../src/ws');

describe('B6: disconnect rejects in-flight tasks', () => {
  it('rejects pending dispatchTask callbacks the moment the socket closes', async () => {
    const server = Object.create(WSServer.prototype);
    server.workers = new Map();
    server.taskCallbacks = new Map();
    server.authFails = new Map();

    const handlers = {};
    const fakeWs = {
      on: (ev, fn) => {
        handlers[ev] = fn;
      },
      send: () => {},
      _socket: { remoteAddress: '203.0.113.9' },
    };
    server.handleConnection(fakeWs, { headers: {} });
    expect(typeof handlers.close).toBe('function');

    server.workers.set(42, {
      id: 42,
      ws: fakeWs,
      status: 'online',
      current_model: 'llama3.1:8b',
      e2eKey: null,
    });

    const pending = server.dispatchTask(42, 500, 'hi', 'llama3.1:8b', null);
    expect(server.taskCallbacks.has(500)).toBe(true);
    expect(server.taskCallbacks.get(500).workerId).toBe(42);

    handlers.close();

    await expect(pending).rejects.toThrow('Worker disconnected');
    expect(server.taskCallbacks.size).toBe(0);
    expect(server.workers.size).toBe(0);
  });

  it("leaves other workers' pending tasks alone", async () => {
    const server = Object.create(WSServer.prototype);
    server.workers = new Map();
    server.taskCallbacks = new Map();
    server.authFails = new Map();

    const handlersA = {};
    const socketA = {
      on: (ev, fn) => {
        handlersA[ev] = fn;
      },
      send: () => {},
      _socket: { remoteAddress: '203.0.113.9' },
    };
    server.handleConnection(socketA, { headers: {} });

    const socketB = { readyState: 1, send: () => {} };
    server.workers.set(1, { id: 1, ws: socketA, status: 'online', current_model: 'm', e2eKey: null });
    server.workers.set(2, { id: 2, ws: socketB, status: 'online', current_model: 'm', e2eKey: null });

    const pendingA = server.dispatchTask(1, 600, 'hi', 'm');
    const pendingB = server.dispatchTask(2, 601, 'hi', 'm');

    handlersA.close();

    await expect(pendingA).rejects.toThrow('Worker disconnected');
    expect(server.taskCallbacks.has(601)).toBe(true);
    expect(server.workers.has(2)).toBe(true);
    // settle B so its 180s timer doesn't keep the process alive
    const cb = server.taskCallbacks.get(601);
    clearTimeout(cb.timeout);
    server.taskCallbacks.delete(601);
    cb.resolve({ response: 'ok' });
    await pendingB;
  });
});

// ---------------------------------------------------------------------------
// B10 — the users leaderboard reads the table money is actually written to.
// ---------------------------------------------------------------------------
describe('B10: users leaderboard reads user_coin_balances', () => {
  it('queries user_coin_balances, not the frozen legacy balance table', async () => {
    const app = express();
    app.use('/api/leaderboard', require('../src/routes/leaderboard'));
    pool.__state.queryImpl = async () => ({ rows: [{ id: 1, name: 'a', earned: 5, spent: 1 }] });

    const res = await request(app).get('/api/leaderboard/users');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const joined = pool.__state.statements.join('\n');
    expect(joined).toContain('user_coin_balances');
    expect(joined).not.toMatch(/LEFT JOIN user_balances/);
  });
});

// ---------------------------------------------------------------------------
// v3.45.0 — double-click guard: one live invoice per subject+kind at a time.
// ---------------------------------------------------------------------------
describe('v3.45.0: purchase double-click guard', () => {
  it('409s a second token purchase while a 90s-window invoice is pending', async () => {
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.includes('FROM plan_purchases') && s.includes("status = 'pending'")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    };

    const token = sign({ id: 306, role: 'user', token_version: 0 });
    const res = await request(plansApp())
      .post('/api/plans/tokens/purchase')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 5 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('purchase_pending');
    expect(nowpayments.createInvoice).not.toHaveBeenCalled();
    expect(pool.__state.statements.join('\n')).not.toMatch(/INSERT INTO plan_purchases/);
  });

  it('409s a second tier purchase while a 90s-window invoice is pending', async () => {
    authDb();
    pool.__state.queryImpl = async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      if (s.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (s.includes('FROM plan_purchases') && s.includes("status = 'pending'")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    };

    const token = sign({ id: 307, role: 'user', token_version: 0 });
    const res = await request(plansApp())
      .post('/api/plans/pro/purchase')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('purchase_pending');
    expect(nowpayments.createInvoice).not.toHaveBeenCalled();
  });
});
