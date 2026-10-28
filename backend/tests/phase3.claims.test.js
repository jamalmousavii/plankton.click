// Phase 3 (v3.33.0) — B4 shared money-claim tests.
// The IPN webhook and the nightly reconciler both apply money through
// services/paymentClaims.js, so exactly-once semantics are tested here once.

jest.mock('../src/database/pool', () => {
  const state = {
    connectImpl: async () => { throw new Error('connectImpl not scripted'); },
  };
  return {
    __state: state,
    connect: () => state.connectImpl(),
    query: async () => ({ rows: [] }),
  };
});

jest.mock('../src/services/plans', () => ({
  PLANS: { plus: { price: 2.99 }, pro: { price: 5.99 }, max: { price: 11.99 } },
  activatePlan: jest.fn(),
}));

jest.mock('../src/services/tokenBundles', () => ({
  creditTokens: jest.fn(),
}));

jest.mock('../src/cache', () => ({
  invalidateCache: jest.fn(),
  getCacheStats: () => ({ connected: false }),
  closeCache: jest.fn(async () => {}),
  cacheMiddleware: () => (req, res, next) => next(),
  isCacheableRequest: () => false,
}));

const pool = require('../src/database/pool');
const { activatePlan } = require('../src/services/plans');
const { creditTokens } = require('../src/services/tokenBundles');
const { invalidateCache } = require('../src/cache');
const { applyPlanPurchase, applyDeposit } = require('../src/services/paymentClaims');

// Fake transaction client: claim UPDATEs return the scripted rows, everything
// else (BEGIN/COMMIT/ROLLBACK/credits) just records the statement.
function makeClient(claimRows) {
  const client = {
    statements: [],
    released: false,
    query: jest.fn(async (sql) => {
      const s = String(sql).trim().replace(/\s+/g, ' ');
      client.statements.push(s);
      if (s.startsWith('UPDATE plan_purchases') || s.startsWith('UPDATE coin_deposits')) {
        return { rows: claimRows };
      }
      return { rows: [] };
    }),
    release() {
      client.released = true;
    },
  };
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.__state.connectImpl = async () => { throw new Error('connectImpl not scripted'); };
});

describe('applyPlanPurchase — exactly-once plan/token claim (B4)', () => {
  it('claims a pending token purchase and credits the pot once', async () => {
    const client = makeClient([{ plan_type: 'tokens', tokens: 5000 }]);
    pool.__state.connectImpl = async () => client;

    const out = await applyPlanPurchase({ userId: 7, orderId: 'tok-7-123', txHash: '0xabc' });

    expect(out).toEqual({ deduped: false, planType: 'tokens' });
    expect(creditTokens).toHaveBeenCalledWith(7, 5000, client);
    expect(client.statements).toContain('COMMIT');
    expect(client.released).toBe(true);
    expect(invalidateCache).toHaveBeenCalledWith('/api/payments/balance');
  });

  it('activates the tier for a plan purchase', async () => {
    const client = makeClient([{ plan_type: 'plus', tokens: 0 }]);
    pool.__state.connectImpl = async () => client;

    const out = await applyPlanPurchase({ userId: 8, orderId: 'plus-8-999' });

    expect(out).toEqual({ deduped: false, planType: 'plus' });
    expect(activatePlan).toHaveBeenCalledWith(8, 'plus', client);
    expect(creditTokens).not.toHaveBeenCalled();
    expect(client.statements).toContain('COMMIT');
  });

  it('dedupes a replayed notification without crediting twice', async () => {
    const client = makeClient([]); // claim matched no pending row
    pool.__state.connectImpl = async () => client;

    const out = await applyPlanPurchase({ userId: 7, orderId: 'tok-7-123' });

    expect(out.deduped).toBe(true);
    expect(creditTokens).not.toHaveBeenCalled();
    expect(activatePlan).not.toHaveBeenCalled();
    expect(client.statements).toContain('COMMIT');
    expect(invalidateCache).not.toHaveBeenCalled();
  });

  it('ignores non-plan order ids without touching the DB', async () => {
    const out = await applyPlanPurchase({ userId: 7, orderId: 'plankton-7-1' });
    expect(out.deduped).toBe(true);
    // connectImpl would have thrown if a transaction had been opened
  });

  it('rolls back when crediting throws, then releases the client', async () => {
    const client = makeClient([{ plan_type: 'tokens', tokens: 5000 }]);
    pool.__state.connectImpl = async () => client;
    creditTokens.mockImplementationOnce(async () => { throw new Error('ledger down'); });

    await expect(
      applyPlanPurchase({ userId: 7, orderId: 'tok-7-5' })
    ).rejects.toThrow('ledger down');

    expect(client.statements).toContain('ROLLBACK');
    expect(client.released).toBe(true);
    expect(invalidateCache).not.toHaveBeenCalled();
  });
});

describe('applyDeposit — exactly-once deposit claim (B4)', () => {
  it('credits the stored amount once and records the transaction', async () => {
    const client = makeClient([{ id: 11, amount: '12.50' }]);
    pool.__state.connectImpl = async () => client;

    const out = await applyDeposit({
      userId: 9,
      orderId: 'plankton-9-1',
      invoiceId: '999',
      cryptoCoin: 'BTC',
    });

    expect(out).toEqual({ deduped: false, amount: 12.5 });
    const joined = client.statements.join('\n');
    expect(joined).toContain('INSERT INTO user_coin_balances');
    expect(joined).toContain('usd_deposit');
    expect(client.statements).toContain('COMMIT');
    expect(client.released).toBe(true);
    expect(invalidateCache).toHaveBeenCalledWith('/api/payments/balance');
  });

  it('dedupes a replay without crediting again', async () => {
    const client = makeClient([]);
    pool.__state.connectImpl = async () => client;

    const out = await applyDeposit({ userId: 9, orderId: 'plankton-9-1', invoiceId: '999' });

    expect(out.deduped).toBe(true);
    expect(client.statements.join('\n')).not.toContain('user_coin_balances');
    expect(client.statements).toContain('COMMIT');
  });

  it('rolls back and rethrows when the credit fails mid-transaction', async () => {
    const client = {
      statements: [],
      released: false,
      query: jest.fn(async (sql) => {
        const s = String(sql).trim().replace(/\s+/g, ' ');
        client.statements.push(s);
        if (s.startsWith('UPDATE coin_deposits')) return { rows: [{ id: 11, amount: '3.00' }] };
        if (s.startsWith('INSERT INTO user_coin_balances')) throw new Error('unique violation');
        return { rows: [] };
      }),
      release() {
        client.released = true;
      },
    };
    pool.__state.connectImpl = async () => client;

    await expect(
      applyDeposit({ userId: 9, orderId: 'plankton-9-2', invoiceId: '1000' })
    ).rejects.toThrow('unique violation');

    expect(client.statements).toContain('ROLLBACK');
    expect(client.released).toBe(true);
    expect(invalidateCache).not.toHaveBeenCalled();
  });
});
