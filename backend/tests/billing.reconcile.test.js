// v3.45.0 — billing reconciliation for tasks the chat/v1 routes marked
// billing_pending (settlement threw after the answer was already served).

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

jest.mock('../src/services/billing', () => ({
  WORKER_REVENUE_SHARE: 0.9,
  settleMessage: jest.fn(async () => ({ paymentStatus: 'free' })),
}));

jest.mock('../src/services/org', () => ({
  resolveCap: jest.fn(async () => ({ cap: 2000000, bucketUserId: 7, org: null })),
}));

const pool = require('../src/database/pool');
const { settleMessage } = require('../src/services/billing');
const { resolveCap } = require('../src/services/org');
const { reconcileBilling } = require('../src/services/maintenance');

beforeEach(() => {
  jest.clearAllMocks();
  pool.__state.statements.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
});

const pendingTask = { id: 42, user_id: 7, worker_id: 9, tokens_used: '120', cost: '0.00001896' };

describe('reconcileBilling (v3.45.0)', () => {
  it('does nothing when there are no pending tasks', async () => {
    await reconcileBilling();
    expect(settleMessage).not.toHaveBeenCalled();
    expect(resolveCap).not.toHaveBeenCalled();
  });

  it('settles a pending task and marks it settled', async () => {
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes("billing_status = 'pending'")) return { rows: [pendingTask] };
      return { rows: [] };
    };
    await reconcileBilling();

    expect(resolveCap).toHaveBeenCalledWith(7, null);
    expect(settleMessage).toHaveBeenCalledTimes(1);
    const arg = settleMessage.mock.calls[0][0];
    expect(arg).toMatchObject({ userId: 7, workerId: 9, taskId: 42, servedByWorker: true });
    expect(arg.tokensUsed).toBe(120);
    expect(arg.cost).toBeCloseTo(0.00001896, 12);
    expect(pool.__state.statements.join('\n')).toMatch(/UPDATE tasks SET billing_status = 'settled'/);
  });

  it('on failure bumps attempts and parks the row as unreconciled at the cap', async () => {
    settleMessage.mockRejectedValueOnce(new Error('db down'));
    pool.__state.queryImpl = async (sql) => {
      if (String(sql).includes("billing_status = 'pending'")) return { rows: [pendingTask] };
      return { rows: [] };
    };
    await reconcileBilling();

    const joined = pool.__state.statements.join('\n');
    expect(joined).toMatch(/billing_attempts = billing_attempts \+ 1/);
    expect(joined).toMatch(/'unreconciled'/);
    expect(joined).not.toMatch(/billing_status = 'settled'/);
  });
});
