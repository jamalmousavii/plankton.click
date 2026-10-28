const {
  FREE_DAILY_TOKENS,
  PLANS,
  TOKEN_BUNDLE,
  WORKER_REVENUE_SHARE,
  listPlans,
  quoteTokens,
  tokenValueUsd,
  getActivePlan,
  getDailyCap,
  activatePlan,
} = require('../src/services/plans');
const { chargeTokenPot, creditTokens, getTokenBalance } = require('../src/services/tokenBundles');
const nowpayments = require('../src/services/nowpayments');

function makeClient(...responses) {
  const statements = [];
  let i = 0;
  return {
    statements,
    query: jest.fn(async (sql, params) => {
      statements.push({ sql: sql.trim().replace(/\s+/g, ' '), params });
      const resp = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return resp;
    }),
  };
}

describe('plan catalog (v3.28.0)', () => {
  it('gives Free twice the best market free tier (Cerebras 1M/day)', () => {
    expect(FREE_DAILY_TOKENS).toBe(2000000);
  });

  it('defines exactly Plus/Pro/Max with the agreed prices and caps', () => {
    expect(Object.keys(PLANS)).toEqual(['plus', 'pro', 'max']);
    expect(PLANS.plus).toMatchObject({ price: 2.99, daily_tokens: 10000000, interval_days: 30 });
    expect(PLANS.pro).toMatchObject({ price: 5.99, daily_tokens: 30000000, interval_days: 30 });
    expect(PLANS.max).toMatchObject({ price: 11.99, daily_tokens: 80000000, interval_days: 30 });
  });

  it('keeps the flat worker share at 90% for every paid leg', () => {
    expect(WORKER_REVENUE_SHARE).toBe(0.9);
  });

  it('prices every tier below the catalog value it unlocks (30 days)', () => {
    // Marginal serving cost is ~0 — but a subscriber must still get more
    // catalog value than the sticker price, or the tier has no pitch.
    for (const p of listPlans()) {
      expect(p.value_usd_month).toBeGreaterThan(p.price);
    }
  });

  it('shows value metrics at the default model output price ($0.025/1M)', () => {
    const plans = listPlans();
    expect(plans).toHaveLength(3);
    const plus = plans.find((p) => p.name === 'plus');
    expect(plus.value_usd_day).toBe(0.25);    // 10M * 0.025 / 1M
    expect(plus.value_usd_month).toBe(7.5);   // 0.25 * 30
    const max = plans.find((p) => p.name === 'max');
    expect(max.value_usd_day).toBe(2);
    expect(max.value_usd_month).toBe(60);
  });

  it('computes token value directly from a token count', () => {
    expect(tokenValueUsd(2000000)).toEqual({ value_usd_day: 0.05, value_usd_month: 1.5 });
  });
});

describe('token bundle (worth exactly its USD price, whole dollars, no expiry)', () => {
  it('quotes default-model tokens per whole dollar ($1 = 40M at $0.025/1M)', () => {
    expect(TOKEN_BUNDLE).toMatchObject({ tokens_per_usd: 40000000, price_per_million: 0.025, min_usd: 1, max_usd: 500 });
    expect(quoteTokens(1)).toBe(40000000);
    expect(quoteTokens(7)).toBe(280000000);
    expect(quoteTokens(500)).toBe(20000000000);
  });

  it('drains the pot by catalog cost, so pricier models use proportionally more', () => {
    const { potTokensFor, modelOutputPrice } = require('../src/services/plans');
    const cost = (tok, model) => (tok * modelOutputPrice(model)) / 1e6;
    expect(potTokensFor(cost(1000, 'llama3.1:8b'))).toBe(1000);
    expect(potTokensFor(cost(1000, 'llama3.3:70b'))).toBe(10000);
    expect(potTokensFor(cost(1, 'llama3.2:3b'))).toBe(1); // never free
    // $1 of pot buys exactly $1 of catalog value.
    expect(potTokensFor(1)).toBe(TOKEN_BUNDLE.tokens_per_usd);
  });
});

describe('getActivePlan / getDailyCap', () => {
  it('returns the biggest cap when several tiers are active at once', async () => {
    const client = makeClient({ rows: [
      { plan_type: 'plus', expires_at: new Date(Date.now() + 86400000) },
      { plan_type: 'max', expires_at: new Date(Date.now() + 86400000) },
    ] });
    const cap = await getDailyCap(7, client);

    expect(cap).toBe(PLANS.max.daily_tokens);
  });

  it('returns the Free cap when no plan row exists', async () => {
    const client = makeClient({ rows: [] });
    const cap = await getDailyCap(7, client);

    expect(cap).toBe(FREE_DAILY_TOKENS);
  });

  it('never queries for a guest (no userId)', async () => {
    const client = makeClient();
    const cap = await getDailyCap(null, client);

    expect(cap).toBe(FREE_DAILY_TOKENS);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('only counts plans that are active and unexpired', async () => {
    const client = makeClient({ rows: [] });
    await getActivePlan(7, client);

    const { sql } = client.statements[0];
    expect(sql).toContain(`status = 'active'`);
    expect(sql).toContain('expires_at > now()');
  });

  it('ignores rows whose plan_type is not in the catalog', async () => {
    const client = makeClient({ rows: [{ plan_type: 'legacy', expires_at: new Date(Date.now() + 86400000) }] });
    const plan = await getActivePlan(7, client);

    expect(plan).toBeNull();
  });
});

describe('activatePlan (renewal extends from the later of now/expiry)', () => {
  it('inserts fresh or extends an existing tier by exactly the interval', async () => {
    const client = makeClient({ rows: [] });
    await activatePlan(7, 'pro', client);

    const { sql, params } = client.statements[0];
    expect(sql).toContain('INSERT INTO user_plans');
    expect(sql).toContain('ON CONFLICT (user_id, plan_type) DO UPDATE');
    expect(sql).toContain('GREATEST');
    expect(sql).toContain(`interval '1 day'`);
    expect(params).toEqual([7, 'pro', 30]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('extends a still-valid plan from its expiry, not from now', async () => {
    const client = makeClient({ rows: [] });
    await activatePlan(7, 'max', client);

    // GREATEST(expires_at, now) + 30d — a mid-cycle renewal never loses days.
    expect(client.statements[0].sql)
      .toContain('GREATEST(COALESCE(user_plans.expires_at, now()), now())');
  });

  it('rejects an unknown tier', async () => {
    const client = makeClient({ rows: [] });
    await expect(activatePlan(7, 'enterprise', client)).rejects.toThrow('Unknown plan tier');
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('token pot (all-or-nothing deduct, race-safe)', () => {
  it('charges only while the balance covers the message', async () => {
    const client = makeClient({ rows: [{ tokens: '1500000' }] });
    const r = await chargeTokenPot({ userId: 7, tokens: 500000, client });

    expect(r).toEqual({ charged: true, remaining: 1500000 });
    const { sql, params } = client.statements[0];
    expect(sql).toContain('UPDATE user_token_balances');
    expect(sql).toContain('WHERE user_id = $1 AND tokens >= $2');
    expect(sql).toContain('RETURNING tokens');
    expect(params).toEqual([7, 500000]);
  });

  it('falls through untouched when the pot cannot cover the message', async () => {
    const client = makeClient({ rows: [] }, { rows: [{ tokens: '100' }] });
    const r = await chargeTokenPot({ userId: 7, tokens: 500000, client });

    expect(r).toEqual({ charged: false, remaining: 100 });
    expect(client.statements[0].sql).toContain('tokens >= $2');
    expect(client.statements[1].sql).toContain('SELECT COALESCE(tokens, 0)');
  });

  it('never charges a guest (no userId)', async () => {
    const client = makeClient();
    const r = await chargeTokenPot({ userId: null, tokens: 10, client });

    expect(r).toEqual({ charged: false, remaining: 0 });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('credits an invoice additively and tracks lifetime purchases', async () => {
    const client = makeClient({ rows: [] });
    await creditTokens(7, 2000000, client);

    const { sql, params } = client.statements[0];
    expect(sql).toContain('INSERT INTO user_token_balances');
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(sql).toContain('total_purchased = user_token_balances.total_purchased');
    expect(params).toEqual([7, 2000000]);
  });

  it('reads a balance of 0 for a user with no pot row', async () => {
    const client = makeClient({ rows: [] });
    expect(await getTokenBalance(7, client)).toBe(0);
    expect(await getTokenBalance(null, makeClient())).toBe(0);
  });
});

describe('NowPayments order ids carry the purchase type', () => {
  it.each([
    ['plus-7-1700000000', PLANS.plus.price],
    ['pro-7-1700000000', PLANS.pro.price],
    ['max-7-1700000000', PLANS.max.price],
  ])('parses a %s order id back to the subscribing user', async (orderId, price) => {
    const result = await nowpayments.processIPN({
      order_id: orderId,
      payment_status: 'finished',
      price_amount: price,
      pay_amount: 0.001,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(7);
    expect(result.amount).toBe(price);
    expect(result.orderId).toBe(orderId);
  });

  it('parses a token bundle order id back to the buyer', async () => {
    const result = await nowpayments.processIPN({
      order_id: 'tok-7-1700000000',
      payment_status: 'finished',
      price_amount: 2,
      pay_amount: 0.002,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(7);
    expect(result.amount).toBe(2);
  });

  it('still parses legacy deposit order ids', async () => {
    const result = await nowpayments.processIPN({
      order_id: 'plankton-7-1700000000',
      payment_status: 'finished',
      price_amount: 25,
    });

    expect(result.userId).toBe(7);
    expect(result.amount).toBe(25);
  });

  it('does not claim unfinished payments', async () => {
    const result = await nowpayments.processIPN({
      order_id: 'pro-7-1700000000',
      payment_status: 'waiting',
      price_amount: PLANS.pro.price,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('waiting');
  });

  // Regression (v3.27.0): the webhook used to also require
  // `result.status === 'finished'`, but the success branch normalizes to
  // 'completed' — so every finished IPN (deposit and purchase) was ignored.
  it('marks finished payments success with normalized status completed', async () => {
    const result = await nowpayments.processIPN({
      order_id: 'max-7-1700000000',
      payment_status: 'finished',
      price_amount: PLANS.max.price,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
  });
});
