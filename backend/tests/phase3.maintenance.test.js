// Phase 3 (v3.33.0) — B4 nightly reconciliation + B11 media retention.

jest.mock('../src/database/pool', () => {
  const state = { statements: [], params: [], queryImpl: async () => ({ rows: [] }) };
  return {
    __state: state,
    query: (sql, params) => {
      state.statements.push(String(sql).trim().replace(/\s+/g, ' '));
      state.params.push(params);
      return state.queryImpl(sql, params);
    },
    connect: async () => { throw new Error('connect not used'); },
  };
});

jest.mock('../src/services/nowpayments', () => ({
  getPaymentStatus: jest.fn(),
}));

jest.mock('../src/services/paymentClaims', () => ({
  applyPlanPurchase: jest.fn(),
  applyDeposit: jest.fn(),
}));

const pool = require('../src/database/pool');
const nowpayments = require('../src/services/nowpayments');
const { applyPlanPurchase, applyDeposit } = require('../src/services/paymentClaims');
const { reconcilePendingPayments, pruneOldMedia } = require('../src/services/maintenance');

function script({ purchases = [], deposits = [], pruned = 0 } = {}) {
  pool.__state.queryImpl = async (sql) => {
    const s = String(sql);
    if (s.includes('FROM plan_purchases')) return { rows: purchases };
    if (s.includes('FROM coin_deposits')) return { rows: deposits };
    if (s.includes('UPDATE tasks')) return { rows: [], rowCount: pruned };
    return { rows: [] };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.__state.statements.length = 0;
  pool.__state.params.length = 0;
  script();
});

describe('reconcilePendingPayments (B4)', () => {
  it('applies finished purchases through the shared exactly-once claim', async () => {
    script({
      purchases: [
        { order_id: 'tok-1-1', user_id: 1, invoice_id: 'inv1' },
        { order_id: 'plus-2-2', user_id: 2, invoice_id: 'inv2' },
      ],
    });
    nowpayments.getPaymentStatus.mockResolvedValue({ success: true, status: { payment_status: 'finished' } });

    await reconcilePendingPayments();

    expect(nowpayments.getPaymentStatus).toHaveBeenCalledTimes(2);
    expect(applyPlanPurchase).toHaveBeenCalledWith({ userId: 1, orderId: 'tok-1-1' });
    expect(applyPlanPurchase).toHaveBeenCalledWith({ userId: 2, orderId: 'plus-2-2' });
    expect(applyDeposit).not.toHaveBeenCalled();
  });

  it('applies finished deposits with their stored invoice id', async () => {
    script({ deposits: [{ order_id: 'plankton-3-3', user_id: 3, processor_id: 'inv3' }] });
    nowpayments.getPaymentStatus.mockResolvedValue({ success: true, status: { payment_status: 'finished' } });

    await reconcilePendingPayments();

    expect(applyDeposit).toHaveBeenCalledWith({
      userId: 3,
      orderId: 'plankton-3-3',
      invoiceId: 'inv3',
    });
    expect(applyPlanPurchase).not.toHaveBeenCalled();
  });

  it('leaves still-waiting invoices alone', async () => {
    script({
      purchases: [{ order_id: 'tok-1-1', user_id: 1, invoice_id: 'inv1' }],
      deposits: [{ order_id: 'plankton-3-3', user_id: 3, processor_id: 'inv3' }],
    });
    nowpayments.getPaymentStatus.mockResolvedValue({ success: true, status: { payment_status: 'waiting' } });

    await reconcilePendingPayments();

    expect(applyPlanPurchase).not.toHaveBeenCalled();
    expect(applyDeposit).not.toHaveBeenCalled();
  });

  it('survives NowPayments API failures without throwing', async () => {
    script({ purchases: [{ order_id: 'tok-1-1', user_id: 1, invoice_id: 'inv1' }] });
    nowpayments.getPaymentStatus.mockResolvedValue({ success: false, error: 'timeout' });

    await expect(reconcilePendingPayments()).resolves.toBeUndefined();
    expect(applyPlanPurchase).not.toHaveBeenCalled();
  });

  it('only scans stale pending rows (30 min old, batch of 25)', async () => {
    await reconcilePendingPayments();

    const purchaseQuery = pool.__state.statements.find((s) => s.includes('FROM plan_purchases'));
    expect(purchaseQuery).toMatch(/status = 'pending'/);
    expect(purchaseQuery).toContain('make_interval');
    expect(pool.__state.params[0]).toEqual([30, 25]);
  });
});

describe('pruneOldMedia (B11)', () => {
  it('nulls media older than the retention window', async () => {
    script({ pruned: 5 });

    await pruneOldMedia();

    const sql = pool.__state.statements.find((s) => s.includes('UPDATE tasks'));
    expect(sql).toContain('SET media = NULL');
    expect(sql).toContain('make_interval');
    expect(pool.__state.params[0]).toEqual([7]); // default 7-day retention
  });

  it('runs without touching anything when nothing is old enough', async () => {
    script({ pruned: 0 });
    await expect(pruneOldMedia()).resolves.toBeUndefined();
    expect(pool.__state.statements.some((s) => s.includes('SET media = NULL'))).toBe(true);
  });
});
