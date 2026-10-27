const {
  WORKER_DAILY_CREDIT_USD,
  getWorkerCreditStatus,
  chargeWorkerCredit,
} = require('../src/services/workerCredit');

// A fake SQL client whose first answer is the worker-online lookup and the
// rest are dispatched by the caller — no real database involved.
function makeClient(eligible, ...followUps) {
  const statements = [];
  let i = 0;
  return {
    statements,
    query: jest.fn(async (sql) => {
      statements.push(sql.trim().replace(/\s+/g, ' '));
      if (i === 0) {
        i += 1;
        return { rows: [{ eligible }] };
      }
      const resp = followUps[Math.min(i - 1, followUps.length - 1)];
      i += 1;
      return resp;
    }),
  };
}

describe('getWorkerCreditStatus', () => {
  it('returns no credit for a user without an online worker', async () => {
    const client = makeClient(false);
    const status = await getWorkerCreditStatus(7, client);

    expect(status).toEqual({
      eligible: false,
      limit: WORKER_DAILY_CREDIT_USD,
      used: 0,
      remaining: 0,
    });
    // Eligibility is checked first; the credit row is never read.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('grants the full daily allowance when no row exists yet', async () => {
    const client = makeClient(true, { rows: [] });
    const status = await getWorkerCreditStatus(7, client);

    expect(status.eligible).toBe(true);
    expect(status.remaining).toBe(WORKER_DAILY_CREDIT_USD);
    expect(status.used).toBe(0);
  });

  it('subtracts today usage from the allowance', async () => {
    const client = makeClient(true, { rows: [{ used: '0.3' }] });
    const status = await getWorkerCreditStatus(7, client);

    expect(status.used).toBeCloseTo(0.3, 8);
    expect(status.remaining).toBeCloseTo(WORKER_DAILY_CREDIT_USD - 0.3, 8);
  });

  it('never reports a negative remaining balance', async () => {
    const client = makeClient(true, { rows: [{ used: '1.5' }] });
    const status = await getWorkerCreditStatus(7, client);

    expect(status.remaining).toBe(0);
  });
});

describe('chargeWorkerCredit', () => {
  const COST = 0.0001;

  it('does not charge when the user has no online worker', async () => {
    const client = makeClient(false);
    const result = await chargeWorkerCredit(7, COST, client);

    expect(result).toEqual({ charged: false, remaining: null });
    // Only the eligibility lookup ran — no upsert, no UPDATE.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('charges a covered cost and reports the new remaining', async () => {
    const client = makeClient(true, { rows: [{ usd_used_today: '0.4' }] });
    const result = await chargeWorkerCredit(7, COST, client);

    expect(result.charged).toBe(true);
    expect(result.remaining).toBeCloseTo(WORKER_DAILY_CREDIT_USD - 0.4 - COST, 10);
    const update = client.statements.find((s) => s.startsWith('UPDATE worker_daily_credit'));
    expect(update).toBeDefined();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET usd_used_today = usd_used_today + $1'),
      [COST, 7]
    );
  });

  it('refuses to spend past the allowance', async () => {
    // 1e-6 left of the $1 allowance while the message costs 1e-4.
    const client = makeClient(true, { rows: [{ usd_used_today: '0.999999' }] });
    const result = await chargeWorkerCredit(7, COST, client);

    expect(result.charged).toBe(false);
    expect(result.remaining).toBeCloseTo(1e-6, 8);
    const update = client.statements.find((s) => s.startsWith('UPDATE worker_daily_credit'));
    expect(update).toBeUndefined();
  });

  it('covers the boundary via epsilon (float drift must not deny a charge)', async () => {
    // remaining = 1 - 0.1 * 10 === 0 in exact math, but floats drift slightly
    // below zero after repeated subtraction; the charge must still succeed.
    let burned = 0;
    for (let k = 0; k < 10; k++) burned += 0.1;
    const used = String(burned); // '0.9999999999999999' or '1'
    const client = makeClient(true, { rows: [{ usd_used_today: used }] });
    const result = await chargeWorkerCredit(7, 1e-9, client);

    expect(result.charged).toBe(true);
  });

  it('rolls a stale row to zero inside the upsert (UTC-day reset)', async () => {
    const client = makeClient(true, { rows: [{ usd_used_today: '0' }] });
    await chargeWorkerCredit(7, COST, client);

    const upsert = client.statements.find((s) => s.startsWith('INSERT INTO worker_daily_credit'));
    expect(upsert).toBeDefined();
    expect(upsert).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(upsert).toContain(`(now() AT TIME ZONE 'utc')::date`);
    expect(upsert).toContain('ELSE 0');
  });
});
