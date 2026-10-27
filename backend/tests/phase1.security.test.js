// Phase 1 (v3.31.0) — security & money tests.
// Pattern: jest.mock the DB pool and NowPayments before routes load, so every
// path here is deterministic and offline (no Postgres, no network).

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
  getWithdrawFee: () => 0.5,
  getSupportedCoins: () => ['btc'],
  verifyIPN: jest.fn(),
  processIPN: jest.fn(),
  createPayout: jest.fn(),
}));

const pool = require('../src/database/pool');
const nowpayments = require('../src/services/nowpayments');

const SECRET = process.env.JWT_SECRET;

function sign(payload) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}

function resetPool() {
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
  pool.__state.connectImpl = async () => { throw new Error('connectImpl not scripted'); };
}

beforeEach(() => {
  resetPool();
  nowpayments.verifyIPN.mockReset();
  nowpayments.processIPN.mockReset();
  nowpayments.createPayout.mockReset();
});

// ---------------------------------------------------------------------------
// C1 — wallet-only WS auth removed: worker_token is the only identity.
// ---------------------------------------------------------------------------
const WSServer = require('../src/ws');

function bareServer() {
  const ws = Object.create(WSServer.prototype);
  ws.authFails = new Map();
  ws.workers = new Map();
  ws.taskCallbacks = new Map();
  return ws;
}

function bareSocket() {
  return {
    _clientIp: '203.0.113.9',
    sent: [],
    send(msg) { this.sent.push(JSON.parse(msg)); },
    close() {},
  };
}

describe('C1: WS auth requires a worker_token (v3.31.0)', () => {
  it('rejects a connection with no credentials', async () => {
    const server = bareServer();
    const ws = bareSocket();
    await server.handleAuth(ws, {});
    expect(ws.sent[0]).toMatchObject({ type: 'auth_error' });
    expect(ws.sent[0].message).toMatch(/worker_token required/);
  });

  it('rejects the legacy wallet_address-only auth (spoofing bypass removed)', async () => {
    const server = bareServer();
    const ws = bareSocket();
    await server.handleAuth(ws, { wallet_address: '0xDEADBEEFdeadbeef' });
    expect(ws.sent[0].type).toBe('auth_error');
    expect(ws.sent[0].message).toMatch(/worker_token required/);
    // The bypass is gone before any query: no DB statement may have run.
    expect(pool.__state.statements).toHaveLength(0);
  });

  it('rejects a malformed token before touching the DB', async () => {
    const server = bareServer();
    const ws = bareSocket();
    await server.handleAuth(ws, { worker_token: 'pw_not-a-real-token' });
    expect(ws.sent[0]).toMatchObject({ type: 'auth_error', message: 'Invalid worker token' });
    expect(pool.__state.statements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H3 — token_version: a bump invalidates every outstanding JWT.
// ---------------------------------------------------------------------------
const { authenticate } = require('../src/middleware/auth');

function authApp() {
  const app = express();
  app.get('/protected', authenticate, (req, res) => res.json({ id: req.user.id }));
  return app;
}

describe('H3: token_version check in authenticate (v3.31.0)', () => {
  const app = authApp();

  function scriptDbVersion(version) {
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: version }] };
      return { rows: [] };
    };
  }

  it('accepts a token whose claim matches the DB', async () => {
    scriptDbVersion(0);
    const token = sign({ id: 101, role: 'user', token_version: 0 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('treats a pre-H3 token (no claim) as version 0', async () => {
    scriptDbVersion(0);
    const token = sign({ id: 102, role: 'user' });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a token issued before a version bump', async () => {
    scriptDbVersion(2);
    const token = sign({ id: 103, role: 'user', token_version: 1 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Session expired/);
  });

  it('rejects a claim newer than the DB too (downgrade attempt)', async () => {
    scriptDbVersion(1);
    const token = sign({ id: 104, role: 'user', token_version: 9 });
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// B2 — IPN webhook: rawBody bytes reach verifyIPN; bad signature dies first.
// ---------------------------------------------------------------------------
const paymentRoutes = require('../src/routes/payments');

function paymentsApp() {
  const app = express();
  // Mirrors server.js: rawBody captured pre-parse (B2).
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api/payments', paymentRoutes);
  return app;
}

describe('B2: IPN webhook verifies over rawBody (v3.31.0)', () => {
  const app = paymentsApp();

  it('passes the exact raw bytes to verifyIPN as the third argument', async () => {
    nowpayments.verifyIPN.mockReturnValue(false);
    const body = { payment_id: 1, payment_status: 'finished' };
    await request(app)
      .post('/api/payments/deposit/webhook')
      .set('x-nowpayments-sig', 'deadbeef')
      .send(body);
    expect(nowpayments.verifyIPN).toHaveBeenCalledTimes(1);
    const [payload, signature, rawBody] = nowpayments.verifyIPN.mock.calls[0];
    expect(payload).toEqual(body);
    expect(signature).toBe('deadbeef');
    expect(Buffer.isBuffer(rawBody)).toBe(true);
    expect(JSON.parse(rawBody.toString())).toEqual(body);
  });

  it('401s when verifyIPN rejects the signature (before the processor)', async () => {
    nowpayments.verifyIPN.mockReturnValue(false);
    nowpayments.processIPN.mockResolvedValue({ success: true });
    const res = await request(app)
      .post('/api/payments/deposit/webhook')
      .set('x-nowpayments-sig', 'forged')
      .send({ payment_status: 'finished' });
    expect(res.status).toBe(401);
    expect(nowpayments.processIPN).not.toHaveBeenCalled();
  });

  it('ignores a validly signed IPN that is not finished', async () => {
    nowpayments.verifyIPN.mockReturnValue(true);
    nowpayments.processIPN.mockResolvedValue({ success: false, status: 'waiting' });
    const res = await request(app)
      .post('/api/payments/deposit/webhook')
      .set('x-nowpayments-sig', 'valid')
      .send({ payment_status: 'waiting' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ignored', payment_status: 'waiting' });
  });
});

// ---------------------------------------------------------------------------
// H2 — withdrawal: debit+record commit together; payout failure refunds.
// ---------------------------------------------------------------------------
describe('H2: withdrawal transactionality (v3.31.0)', () => {
  const app = paymentsApp();

  function scriptWithdraw({ debitRows }) {
    pool.__state.connectImpl = async (push) => ({
      query: async (sql) => {
        const s = String(sql).trim().replace(/\s+/g, ' ');
        push(s);
        if (s.includes('UPDATE user_coin_balances') && s.includes('available >=')) {
          return { rows: debitRows };
        }
        if (s.includes('INSERT INTO coin_withdrawals')) return { rows: [{ id: 11 }] };
        if (s.includes('INSERT INTO transactions')) return { rows: [{ id: 22 }] };
        return { rows: [] };
      },
      release: jest.fn(),
    });
    // balance lookup after a failed debit (insufficient-balance message)
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes('SELECT available')) return { rows: [{ available: 1.25 }] };
      return { rows: [] };
    };
  }

  function withdrawReq(userId) {
    const token = sign({ id: userId, role: 'user', token_version: 0 });
    // Valid TRC20: T + 33 base58 chars (34 total)
    return request(app)
      .post('/api/payments/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 10, toAddress: 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  }

  it('rolls back (no payout call) when the balance is insufficient', async () => {
    scriptWithdraw({ debitRows: [] });
    const res = await withdrawReq(201);
    expect(res.status).toBe(400);
    expect(nowpayments.createPayout).not.toHaveBeenCalled();
    const joined = pool.__state.statements.join('\n');
    expect(joined).not.toMatch(/INSERT INTO coin_withdrawals/);
    expect(joined).toMatch(/ROLLBACK/);
  });

  it('refunds the debit and records the failure when the payout fails', async () => {
    scriptWithdraw({ debitRows: [{ available: 90 }] });
    nowpayments.createPayout.mockResolvedValue({ success: false, error: 'gateway down' });

    const res = await withdrawReq(202);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/refunded/);

    const joined = pool.__state.statements.join('\n');
    // money came back out of the hold
    expect(joined).toMatch(/available = available \+/);
    // every movement left a record
    expect(joined).toMatch(/INSERT INTO coin_withdrawals/);
    expect(joined).toMatch(/UPDATE coin_withdrawals SET status = 'failed'/);
    expect(joined).toMatch(/UPDATE transactions SET status = 'refunded'/);
    // settle ran inside its own txn
    expect(joined).toMatch(/COMMIT/);
  });

  it('marks withdrawal + ledger completed on a successful payout', async () => {
    scriptWithdraw({ debitRows: [{ available: 90 }] });
    nowpayments.createPayout.mockResolvedValue({ success: true, txHash: '0xabc' });

    const res = await withdrawReq(203);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.withdrawal.txHash).toBe('0xabc');

    const joined = pool.__state.statements.join('\n');
    expect(joined).toMatch(/UPDATE coin_withdrawals SET status = 'completed'/);
    expect(joined).toMatch(/UPDATE transactions SET status = 'completed'/);
    expect(joined).not.toMatch(/available = available \+/);
  });

  it('refunds when createPayout throws instead of losing the debit', async () => {
    scriptWithdraw({ debitRows: [{ available: 90 }] });
    nowpayments.createPayout.mockRejectedValue(new Error('socket hang up'));

    const res = await withdrawReq(204);
    expect(res.status).toBe(500);
    const joined = pool.__state.statements.join('\n');
    expect(joined).toMatch(/available = available \+/);
    expect(joined).toMatch(/UPDATE coin_withdrawals SET status = 'failed'/);
  });
});
