// Phase 6 (v3.36.0) — integration tests against a real PostgreSQL.
// CI provides the database (postgres service + DATABASE_URL); locally the
// suite skips unless DATABASE_URL is exported, so `npm test` stays green with
// no database running. Unlike the unit suites, these tests do NOT mock the
// pool: they run the real money path end-to-end — schema migration → register
// → invoice → signed IPN → exactly-once wallet credit → balance read.
//
// Only NowPayments' outbound HTTP call (createInvoice) is stubbed; verifyIPN,
// processIPN and the claim helpers all run for real.

const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const d = HAVE_DB ? describe : describe.skip;

jest.setTimeout(30000);

const request = require('supertest');
const express = require('express');
const pool = require('../src/database/pool');
const nowpayments = require('../src/services/nowpayments');
const authRouter = require('../src/routes/auth');
const paymentsRouter = require('../src/routes/payments');

const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const BACKEND_DIR = path.join(__dirname, '..');

function app() {
  const a = express();
  a.use(express.json({
    limit: '1mb',
    // Mirror server.js: raw bytes are captured pre-parse for IPN verification.
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));
  a.use('/api/auth', authRouter);
  a.use('/api/payments', paymentsRouter);
  return a;
}

function canonicalIpn(payload) {
  return Object.keys(payload).sort().reduce((acc, key) => {
    acc[key] = payload[key];
    return acc;
  }, {});
}

function signIpn(raw) {
  return crypto.createHmac('sha512', IPN_SECRET).update(raw).digest('hex');
}

function migrate() {
  execSync('node src/database/migrate.js', { cwd: BACKEND_DIR, stdio: 'pipe' });
}

d('real-database money flow', () => {
  let realCreateInvoice;

  beforeAll(() => {
    realCreateInvoice = nowpayments.createInvoice;
    migrate();
  });

  afterAll(() => {
    nowpayments.createInvoice = realCreateInvoice;
    return pool.end();
  });

  it('re-runs migrate on an already-migrated schema (idempotent)', () => {
    expect(() => migrate()).not.toThrow();
  });

  it('register → invoice → signed IPN credits the wallet exactly once', async () => {
    nowpayments.createInvoice = jest.fn().mockResolvedValue({
      success: true,
      invoiceId: 'inv-it-0001',
      invoiceUrl: 'https://np.test/i/inv-it-0001',
      payAddress: 'bc1qtestaddress',
      payAmount: 0.001,
    });

    const email = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const reg = await request(app())
      .post('/api/auth/register')
      .send({ email, password: 'Str0ng-Pass-99' });
    expect(reg.status).toBe(201);
    expect(reg.body.success).toBe(true);
    const { token, user } = reg.body;
    expect(token).toBeTruthy();

    const dep = await request(app())
      .post('/api/payments/deposit/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 25 });
    expect(dep.status).toBe(201);

    const order = await pool.query(
      'SELECT order_id FROM coin_deposits WHERE user_id = $1 AND status = $2 ORDER BY id DESC LIMIT 1',
      [user.id, 'pending']
    );
    expect(order.rows.length).toBe(1);
    const orderId = order.rows[0].order_id;
    expect(orderId).toMatch(/^plankton-/);

    const ipn = canonicalIpn({
      order_id: orderId,
      invoice_id: 'inv-it-0001',
      payment_status: 'finished',
      price_amount: 25,
      price_currency: 'usd',
      pay_amount: 0.001,
      pay_currency: 'btc',
      tx_hash: '0xdeadbeef',
    });
    const raw = JSON.stringify(ipn);
    const sig = signIpn(raw);

    const first = await request(app())
      .post('/api/payments/deposit/webhook')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', sig)
      .send(raw);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: 'ok' });

    const bal = await request(app())
      .get('/api/payments/balance')
      .set('Authorization', `Bearer ${token}`);
    expect(bal.status).toBe(200);
    expect(bal.body.balances.USD.available).toBeCloseTo(25, 5);

    // Replay must not credit again (exactly-once claim).
    const replay = await request(app())
      .post('/api/payments/deposit/webhook')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', sig)
      .send(raw);
    expect(replay.status).toBe(200);
    expect(replay.body.deduped).toBe(true);

    const bal2 = await request(app())
      .get('/api/payments/balance')
      .set('Authorization', `Bearer ${token}`);
    expect(bal2.body.balances.USD.available).toBeCloseTo(25, 5);

    const claimed = await pool.query(
      'SELECT status, amount FROM coin_deposits WHERE order_id = $1',
      [orderId]
    );
    expect(claimed.rows[0].status).toBe('completed');
    expect(parseFloat(claimed.rows[0].amount)).toBe(25);
  });

  it('rejects tampered and forged IPN signatures', async () => {
    nowpayments.createInvoice = jest.fn().mockResolvedValue({
      success: true,
      invoiceId: 'inv-it-0002',
      invoiceUrl: 'https://np.test/i/inv-it-0002',
      payAddress: 'bc1qtestaddress',
      payAmount: 0.001,
    });

    const email = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const reg = await request(app())
      .post('/api/auth/register')
      .send({ email, password: 'Str0ng-Pass-99' });
    expect(reg.status).toBe(201);
    const { token, user } = reg.body;

    await request(app())
      .post('/api/payments/deposit/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount_usd: 25 });
    const order = await pool.query(
      'SELECT order_id FROM coin_deposits WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [user.id]
    );
    const orderId = order.rows[0].order_id;

    const original = canonicalIpn({
      order_id: orderId,
      payment_status: 'finished',
      price_amount: 25,
    });
    const tampered = { ...original, price_amount: 999999 };
    const forged = 'f'.repeat(128); // right length, wrong key

    const bad1 = await request(app())
      .post('/api/payments/deposit/webhook')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', signIpn(JSON.stringify(original)))
      .send(JSON.stringify(tampered));
    expect(bad1.status).toBe(401);

    const bad2 = await request(app())
      .post('/api/payments/deposit/webhook')
      .set('Content-Type', 'application/json')
      .set('x-nowpayments-sig', forged)
      .send(JSON.stringify(original));
    expect(bad2.status).toBe(401);

    // Nothing was credited.
    const bal = await request(app())
      .get('/api/payments/balance')
      .set('Authorization', `Bearer ${token}`);
    expect(bal.body.balances.USD.available).toBeCloseTo(0, 5);
  });
});
