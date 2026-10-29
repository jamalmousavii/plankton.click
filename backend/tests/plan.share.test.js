// Plan revenue share: every token a worker serves to a paid-plan subscriber
// earns 90% of (plan price / 30 days / daily token cap). Free tier pays nothing.

const mockStatements = [];
const mockClient = {
  query: jest.fn(async (sql, params) => {
    mockStatements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [] };
  }),
  release: jest.fn(),
};

jest.mock('../src/database/pool', () => ({
  query: jest.fn(async () => ({ rows: [] })),
  connect: jest.fn(async () => mockClient),
}));
jest.mock('../src/services/freeAllowance', () => ({
  chargeFreeTokens: jest.fn(async ({ tokens, cap }) => ({ charged: true, remaining: cap - tokens })),
}));
jest.mock('../src/services/workerCredit', () => ({ chargeWorkerCredit: jest.fn() }));
jest.mock('../src/services/tokenBundles', () => ({ chargeTokenPot: jest.fn() }));

const plans = require('../src/services/plans');
const { settleMessage } = require('../src/services/billing');

let activePlan = null;
beforeEach(() => {
  mockStatements.length = 0;
  activePlan = null;
});

// billing.js destructured getActivePlan at load time, so stub the DB read it
// performs instead: user_plans lookups return the plan under test.
mockClient.query.mockImplementation(async (sql, params) => {
  mockStatements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  if (String(sql).includes('FROM user_plans')) {
    return { rows: activePlan ? [{ plan_type: activePlan, expires_at: new Date(Date.now() + 864e5) }] : [] };
  }
  return { rows: [] };
});

const earningsRows = () => mockStatements.filter((s) => s.sql.startsWith('INSERT INTO worker_coin_earnings'));

describe('plan per-token rate', () => {
  it('Plus: $2.99 / 30 days / 10M tokens, worker gets 90%', () => {
    expect(plans.planTokenRate('plus') * 1e6).toBeCloseTo(2.99 / 30 / 10, 12); // $0.00997 per 1M
    expect(plans.planWorkerEarning('plus', 1e6)).toBeCloseTo((2.99 / 30 / 10) * 0.9, 12); // $0.00897
    // 1M of the 10M daily cap = 10% of 90% of the daily price.
    expect(plans.planWorkerEarning('plus', 1e6)).toBeCloseTo((2.99 / 30) * 0.9 * 0.1, 12);
  });

  it('a full day of the cap pays out exactly 90% of the daily price, never more', () => {
    for (const tier of ['plus', 'pro', 'max']) {
      const p = plans.PLANS[tier];
      expect(plans.planWorkerEarning(tier, p.daily_tokens)).toBeCloseTo((p.price / 30) * 0.9, 10);
      expect(plans.planWorkerEarning(tier, p.daily_tokens) * 30).toBeLessThanOrEqual(p.price * 0.9 + 1e-9);
    }
  });

  it('publishes the worker rate in the plan catalog', () => {
    const plus = plans.listPlans().find((p) => p.name === 'plus');
    expect(plus.worker_usd_per_million).toBeCloseTo(0.00897, 6);
  });

  it('pays nothing for unknown tiers or bad token counts', () => {
    expect(plans.planWorkerEarning('free', 1e6)).toBe(0);
    expect(plans.planWorkerEarning('plus', -5)).toBe(0);
    expect(plans.planWorkerEarning('plus', NaN)).toBe(0);
  });
});

describe('settleMessage plan leg', () => {
  const base = { userId: 7, guestKey: null, tokensUsed: 1000000, cost: 0.025, workerId: 3, servedByWorker: true, taskId: 9 };

  it('credits the serving worker its per-token share for a Plus subscriber', async () => {
    activePlan = 'plus';
    const out = await settleMessage({ ...base, freeCap: 10000000 });
    expect(out.paymentStatus).toBe('plan');
    const rows = earningsRows();
    expect(rows).toHaveLength(1);
    const [workerId, coin, amount, taskId, source, planType] = rows[0].params;
    expect({ workerId, coin, taskId, source, planType }).toEqual({ workerId: 3, coin: 'USD', taskId: 9, source: 'plan', planType: 'plus' });
    expect(amount).toBeCloseTo((2.99 / 30 / 10) * 0.9, 12);
  });

  it('burns and pays by model weight: 100K tokens of a 70B = 1M allowance tokens', async () => {
    activePlan = 'plus';
    const { chargeFreeTokens } = require('../src/services/freeAllowance');
    chargeFreeTokens.mockClear();
    await settleMessage({ ...base, tokensUsed: 100000, cost: (100000 * 0.25) / 1e6, freeCap: 10000000 });
    expect(chargeFreeTokens).toHaveBeenCalledWith(expect.objectContaining({ tokens: 1000000 }));
    expect(earningsRows()[0].params[2]).toBeCloseTo((2.99 / 30 / 10) * 0.9, 12);
  });

  it('pays the worker nothing for a Free-tier user', async () => {
    activePlan = null;
    const out = await settleMessage({ ...base, freeCap: 2000000 });
    expect(out.paymentStatus).toBe('free');
    expect(earningsRows()).toHaveLength(0);
  });

  it('pays nothing when no worker served the task', async () => {
    activePlan = 'pro';
    await settleMessage({ ...base, freeCap: 30000000, servedByWorker: false });
    expect(earningsRows()).toHaveLength(0);
  });
});
