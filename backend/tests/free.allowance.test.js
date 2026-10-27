const { getFreeStatus, chargeFreeTokens } = require('../src/services/freeAllowance');
const { FREE_DAILY_TOKENS, PLANS } = require('../src/services/plans');

// Sequential fake client: each query() pops the next scripted response —
// no real database involved (same pattern as worker.credit.test.js).
function makeClient(...responses) {
  const statements = [];
  let i = 0;
  return {
    statements,
    query: jest.fn(async (sql) => {
      statements.push(sql.trim().replace(/\s+/g, ' '));
      const resp = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return resp;
    }),
  };
}

describe('getFreeStatus', () => {
  it('reports the full Free allowance when no row exists', async () => {
    const client = makeClient({ rows: [] });
    const status = await getFreeStatus({ userId: 7, client });

    expect(status).toEqual({ limit: FREE_DAILY_TOKENS, used: 0, remaining: FREE_DAILY_TOKENS });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('respects a plan-sized cap (Pro is 15x Free)', async () => {
    const client = makeClient({ rows: [] });
    const status = await getFreeStatus({ userId: 7, cap: PLANS.pro.daily_tokens, client });

    expect(status.limit).toBe(PLANS.pro.daily_tokens);
    expect(status.remaining).toBe(PLANS.pro.daily_tokens);
    expect(status.limit).toBe(FREE_DAILY_TOKENS * 15);
  });

  it('subtracts today usage from the allowance', async () => {
    const client = makeClient({ rows: [{ used: '500000' }] });
    const status = await getFreeStatus({ userId: 7, client });

    expect(status.used).toBe(500000);
    expect(status.remaining).toBe(FREE_DAILY_TOKENS - 500000);
  });

  it('never reports a negative remaining balance', async () => {
    const client = makeClient({ rows: [{ used: '99999999' }] });
    const status = await getFreeStatus({ userId: 7, client });

    expect(status.remaining).toBe(0);
  });

  it('reads a guest row from the guest table', async () => {
    const client = makeClient({ rows: [{ used: '10' }] });
    const status = await getFreeStatus({ guestKey: '203.0.113.9', client });

    expect(status.used).toBe(10);
    const read = client.statements[0];
    expect(read).toContain('FROM daily_tokens_guest');
    expect(read).toContain(`(now() AT TIME ZONE 'utc')::date`);
  });

  it('returns a full allowance without querying when there is no subject', async () => {
    const client = makeClient();
    const status = await getFreeStatus({ client });

    expect(status).toEqual({ limit: FREE_DAILY_TOKENS, used: 0, remaining: FREE_DAILY_TOKENS });
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('chargeFreeTokens', () => {
  it('charges a covered amount and reports the new remaining', async () => {
    const client = makeClient({ rows: [{ tokens_used_today: '1000' }] }, { rows: [{}] });
    const result = await chargeFreeTokens({ userId: 7, tokens: 500, client });

    expect(result.charged).toBe(true);
    expect(result.remaining).toBe(FREE_DAILY_TOKENS - 1000 - 500);
    const update = client.statements.find((s) => s.startsWith('UPDATE daily_tokens'));
    expect(update).toBeDefined();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET tokens_used_today = tokens_used_today + $1'),
      [500, 7]
    );
  });

  it('refuses to spend past the allowance', async () => {
    const almostFull = String(FREE_DAILY_TOKENS - 10);
    const client = makeClient({ rows: [{ tokens_used_today: almostFull }] });
    const result = await chargeFreeTokens({ userId: 7, tokens: 500, client });

    expect(result.charged).toBe(false);
    expect(result.remaining).toBe(10);
    const update = client.statements.find((s) => s.startsWith('UPDATE daily_tokens'));
    expect(update).toBeUndefined();
  });

  it('covers the boundary via epsilon (float drift must not deny a charge)', async () => {
    const oneLeft = String(FREE_DAILY_TOKENS - 1);
    const client = makeClient({ rows: [{ tokens_used_today: oneLeft }] });
    const result = await chargeFreeTokens({ userId: 7, tokens: 1, client });

    expect(result.charged).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('rolls a stale row to zero inside the upsert (UTC-day reset)', async () => {
    const client = makeClient({ rows: [{ tokens_used_today: '0' }] }, { rows: [{}] });
    await chargeFreeTokens({ userId: 7, tokens: 10, client });

    const upsert = client.statements.find((s) => s.startsWith('INSERT INTO daily_tokens '));
    expect(upsert).toBeDefined();
    expect(upsert).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(upsert).toContain(`(now() AT TIME ZONE 'utc')::date`);
    expect(upsert).toContain('ELSE 0');
  });

  it('charges guests against the guest table keyed by IP', async () => {
    const client = makeClient({ rows: [{ tokens_used_today: '0' }] }, { rows: [{}] });
    const result = await chargeFreeTokens({ guestKey: '203.0.113.9', tokens: 42, client });

    expect(result.charged).toBe(true);
    const upsert = client.statements[0];
    expect(upsert).toContain('INSERT INTO daily_tokens_guest (guest_key');
    expect(client.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE daily_tokens_guest'),
      [42, '203.0.113.9']
    );
  });

  it('treats an untrackable subject as a no-op that never blocks', async () => {
    const client = makeClient();
    const result = await chargeFreeTokens({ tokens: 100, client });

    expect(result).toEqual({ charged: true, remaining: FREE_DAILY_TOKENS });
    expect(client.query).not.toHaveBeenCalled();
  });
});
