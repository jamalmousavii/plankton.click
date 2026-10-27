// Phase 6 (v3.36.0) — hardening regressions:
//  * the error branch of task_result got the same replay guard as the success
//    branch (a duplicate must not resolve a callback or re-run state changes);
//  * worker-controlled text reflected into chat's 503 is sanitised;
//  * POST /api/payments/deduct was removed (self-deduct with no ledger), and
//    NowPayments provider error bodies never reach the client.

jest.mock('../src/database/pool', () => {
  const state = {
    statements: [],
    queryImpl: async () => ({ rows: [] }),
  };
  return {
    __state: state,
    query: (sql, params) => {
      state.statements.push(String(sql).replace(/\s+/g, ' ').trim());
      return state.queryImpl(sql, params);
    },
    connect: async () => { throw new Error('connect not used'); },
  };
});

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 7 }; next(); },
  strictIfHeader: (_req, _res, next) => next(),
}));

jest.mock('../src/services/nowpayments', () => ({
  getSupportedCoins: () => ({ BTC: {}, ETH: {} }),
  getMinUsdDeposit: () => 1,
  getWithdrawFee: () => 0.5,
  verifyIPN: jest.fn(),
  processIPN: jest.fn(),
  createPayout: jest.fn(),
  createInvoice: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const pool = require('../src/database/pool');
const nowpayments = require('../src/services/nowpayments');
const WSServer = require('../src/ws');
const chatRouter = require('../src/routes/chat');
const paymentsRouter = require('../src/routes/payments');

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
});

// ---------------------------------------------------------------------------
// task_result: error branch replay guard (mirrors the success branch).
// ---------------------------------------------------------------------------
describe('task_result error replay guard', () => {
  function bareWs() {
    const ws = Object.create(WSServer.prototype);
    ws.workers = new Map();
    ws.taskCallbacks = new Map();
    return ws;
  }

  function authenticated() {
    const ws = bareWs();
    const sock = { send: jest.fn() };
    ws.workers.set(1, { id: 1, ws: sock });
    return { ws, sock };
  }

  it('resolves the pending callback once and guards the UPDATE', async () => {
    const { ws, sock } = authenticated();
    pool.__state.queryImpl = async (sql) => {
      if (/SELECT worker_id FROM tasks/.test(sql)) return { rows: [{ worker_id: 1 }] };
      if (/UPDATE tasks/.test(sql)) return { rows: [{ id: 5 }] };
      return { rows: [] };
    };
    const cb = { timeout: setTimeout(() => {}, 60000), resolve: jest.fn() };
    ws.taskCallbacks.set(5, cb);

    await ws.handleTaskResult(sock, { task_id: 5, error: 'worker exploded' });

    expect(cb.resolve).toHaveBeenCalledTimes(1);
    expect(cb.resolve).toHaveBeenCalledWith(expect.objectContaining({ error: 'worker exploded' }));
    clearTimeout(cb.timeout);

    const update = pool.__state.statements.find((s) => s.startsWith('UPDATE tasks'));
    expect(update).toBeDefined();
    expect(update).toMatch(/status IN \('pending', 'processing'\)/);
    expect(update).toMatch(/RETURNING id/);
    expect(update).toMatch(/status = 'failed'/);
  });

  it('ignores a replayed error without resolving a callback', async () => {
    const { ws, sock } = authenticated();
    pool.__state.queryImpl = async (sql) => {
      if (/SELECT worker_id FROM tasks/.test(sql)) return { rows: [{ worker_id: 1 }] };
      if (/UPDATE tasks/.test(sql)) return { rows: [] }; // task already terminal
      return { rows: [] };
    };
    const cb = { timeout: setTimeout(() => {}, 60000), resolve: jest.fn() };
    ws.taskCallbacks.set(5, cb);

    await ws.handleTaskResult(sock, { task_id: 5, error: 'late duplicate' });

    expect(cb.resolve).not.toHaveBeenCalled();
    expect(ws.taskCallbacks.has(5)).toBe(true);
    clearTimeout(cb.timeout);
  });

  it('still rejects results for tasks assigned to another worker', async () => {
    const { ws, sock } = authenticated();
    pool.__state.queryImpl = async (sql) => {
      if (/SELECT worker_id FROM tasks/.test(sql)) return { rows: [{ worker_id: 99 }] };
      return { rows: [] };
    };

    await ws.handleTaskResult(sock, { task_id: 5, error: 'forged' });

    const update = pool.__state.statements.find((s) => s.startsWith('UPDATE tasks'));
    expect(update).toBeUndefined();
    expect(sock.send).toHaveBeenCalledWith(expect.stringContaining('Task not assigned to this worker'));
  });
});

// ---------------------------------------------------------------------------
// chat 503: worker-controlled error text is sanitised before it reaches users.
// ---------------------------------------------------------------------------
describe('sanitise worker detail in the 503 body', () => {
  const sanitize = chatRouter.__sanitizeWorkerDetail;

  it('is exposed by the router', () => {
    expect(typeof sanitize).toBe('function');
  });

  it('strips control characters and angle brackets', () => {
    expect(sanitize('line1\nline2\t<svg onload=x>\u0007')).toBe('line1 line2 svg onload=x');
  });

  it('caps the length at 80 characters', () => {
    expect(sanitize('x'.repeat(500))).toHaveLength(80);
  });

  it('coerces non-string values', () => {
    expect(sanitize(42)).toBe('42');
    expect(sanitize(undefined)).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// payments cleanup: deduct removed, provider errors stay server-side.
// ---------------------------------------------------------------------------
describe('payments route cleanup', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/payments', paymentsRouter);
    return a;
  }

  it('POST /api/payments/deduct is gone (no unledgered self-deduct)', async () => {
    const res = await request(app()).post('/api/payments/deduct').send({ amount: 999 });
    expect(res.status).toBe(404);
    expect(pool.__state.statements.some((s) => s.includes('UPDATE'))).toBe(false);
  });

  it('never forwards NowPayments error text to the client', async () => {
    nowpayments.createInvoice.mockResolvedValue({
      success: false,
      error: 'E_FORBIDDEN: ipn callback secret=super-secret',
    });

    const res = await request(app())
      .post('/api/payments/deposit/create')
      .send({ amount_usd: 25, coin: 'BTC' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Invoice creation failed');
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret|E_FORBIDDEN/);

    // The pending row still gets marked failed (B4 behaviour unchanged).
    expect(pool.__state.statements.some((s) => s.includes('INSERT INTO coin_deposits'))).toBe(true);
    expect(pool.__state.statements.some((s) => s.includes("SET status = 'failed'"))).toBe(true);
  });
});
