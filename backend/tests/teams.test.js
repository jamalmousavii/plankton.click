// Teams own their plan and token pot. Members pay from the team's daily
// plan allowance first, then its pot, then personal coverage; owners can cap
// members per day; workers earn from team money like from personal money.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/database/pool', () => {
  const state = { statements: [], params: [], queryImpl: async () => ({ rows: [] }) };
  const norm = (sql) => String(sql).trim().replace(/\s+/g, ' ');
  const run = (sql, params) => {
    state.statements.push(norm(sql));
    state.params.push(params);
    return state.queryImpl(norm(sql), params);
  };
  return { __state: state, query: run, connect: async () => ({ query: run, release: () => {} }) };
});

const pool = require('../src/database/pool');
const { chargeTeam, setTeamPlan, adjustTeamTokens } = require('../src/services/team');
const { settleMessage } = require('../src/services/billing');

const sign = (id, role = 'user') => jwt.sign({ id, role, token_version: 0 }, process.env.JWT_SECRET, { algorithm: 'HS256' });

beforeEach(() => {
  pool.__state.statements.length = 0;
  pool.__state.params.length = 0;
  pool.__state.queryImpl = async () => ({ rows: [] });
});

const ran = (re) => pool.__state.statements.some((s) => re.test(s));
const paramsOf = (re) => {
  const i = pool.__state.statements.findIndex((s) => re.test(s));
  return i < 0 ? null : pool.__state.params[i];
};

// A small in-memory team: plan tier (or null), team usage today, pot,
// member usage today and member daily_limit.
function teamDb({ plan = 'plus', teamUsed = 0, pot = 0, memberUsed = 0, limit = null, member = true } = {}) {
  pool.__state.queryImpl = async (sql) => {
    if (/FROM team_members m JOIN teams t/.test(sql)) {
      return { rows: member ? [{ id: 9, name: 'Crew', owner_user_id: 1, role: 'member', daily_limit: limit }] : [] };
    }
    if (/INSERT INTO team_member_daily/.test(sql)) return { rows: [{ tokens_used_today: memberUsed }] };
    if (/SELECT plan_type, expires_at FROM team_plans WHERE team_id = \$1 AND status = 'active'/.test(sql)) {
      return { rows: plan ? [{ plan_type: plan, expires_at: new Date(Date.now() + 864e5) }] : [] };
    }
    if (/INSERT INTO team_daily_usage/.test(sql)) return { rows: [{ tokens_used_today: teamUsed }] };
    if (/UPDATE team_token_balances SET tokens = tokens - \$2/.test(sql)) {
      return { rows: pot >= 1 ? [{ tokens: pot - 1 }] : [] };
    }
    if (/FROM user_plans/.test(sql)) return { rows: [] };
    if (/INSERT INTO daily_tokens/.test(sql)) return { rows: [{ tokens_used_today: 0 }] };
    return { rows: [] };
  };
}

describe('chargeTeam', () => {
  const client = { query: (...a) => pool.query(...a) };

  it('charges the team plan allowance first and records the member', async () => {
    teamDb({ plan: 'plus', teamUsed: 0 });
    const r = await chargeTeam({ userId: 5, weighted: 1000, client });
    expect(r).toMatchObject({ charged: 'plan', teamId: 9, planType: 'plus' });
    expect(paramsOf(/UPDATE team_daily_usage SET tokens_used_today/)).toEqual([9, 1000]);
    expect(paramsOf(/UPDATE team_member_daily SET tokens_used_today/)).toEqual([9, 5, 1000]);
  });

  it('falls back to the team pot when the plan allowance is spent', async () => {
    teamDb({ plan: 'plus', teamUsed: 10000000, pot: 5000 });
    const r = await chargeTeam({ userId: 5, weighted: 1000, client });
    expect(r.charged).toBe('tokens');
    expect(ran(/UPDATE team_daily_usage SET tokens_used_today/)).toBe(false);
  });

  it('respects the member daily limit (falls through to personal)', async () => {
    teamDb({ plan: 'max', memberUsed: 900, limit: 1000 });
    const r = await chargeTeam({ userId: 5, weighted: 200, client });
    expect(r).toMatchObject({ charged: null, limited: true });
    expect(ran(/team_daily_usage/)).toBe(false);
  });

  it('does nothing for users without a team, or when the team cannot pay', async () => {
    teamDb({ member: false });
    expect((await chargeTeam({ userId: 5, weighted: 10, client })).charged).toBeNull();
    teamDb({ plan: null, pot: 0 });
    expect((await chargeTeam({ userId: 5, weighted: 10, client })).charged).toBeNull();
  });
});

describe('settleMessage team legs', () => {
  const base = { userId: 5, guestKey: null, tokensUsed: 1000000, cost: 0.025, workerId: 3, servedByWorker: true, freeCap: 2000000, taskId: 77 };
  const earning = () => paramsOf(/INSERT INTO worker_coin_earnings/);

  it('team plan: status team_plan, worker earns the TEAM tier share', async () => {
    teamDb({ plan: 'pro' });
    const out = await settleMessage(base);
    expect(out.paymentStatus).toBe('team_plan');
    const [workerId, , amount, taskId, source, planType] = earning();
    expect({ workerId, taskId, source, planType }).toEqual({ workerId: 3, taskId: 77, source: 'plan', planType: 'pro' });
    expect(amount).toBeCloseTo((5.99 / 30 / 30) * 0.9, 12);
    expect(ran(/INSERT INTO daily_tokens/)).toBe(false); // personal allowance untouched
  });

  it('team pot: status team_tokens, worker earns 90% of catalog cost', async () => {
    teamDb({ plan: null, pot: 5000000 });
    const out = await settleMessage(base);
    expect(out.paymentStatus).toBe('team_tokens');
    expect(earning()[2]).toBeCloseTo(0.025 * 0.9, 12);
    expect(earning()[4]).toBe('tokens');
  });

  it('no team coverage: personal chain runs as before', async () => {
    teamDb({ plan: null, pot: 0 });
    const out = await settleMessage(base);
    expect(out.paymentStatus).toBe('free');
    expect(ran(/INSERT INTO daily_tokens/)).toBe(true);
  });
});

describe('team plan / tokens helpers', () => {
  const client = { query: (...a) => pool.query(...a) };

  it('setTeamPlan cancels other tiers then sets the chosen one for N days; free cancels all', async () => {
    pool.__state.queryImpl = async (sql) => (/SELECT plan_type, expires_at FROM team_plans WHERE team_id = \$1 AND plan_type/.test(sql)
      ? { rows: [{ plan_type: 'max', expires_at: 'x' }] } : { rows: [] });
    expect(await setTeamPlan(9, 'max', 10, client)).toEqual({ plan_type: 'max', expires_at: 'x' });
    expect(paramsOf(/INSERT INTO team_plans/)).toEqual([9, 'max', 10]);
    pool.__state.statements.length = 0;
    pool.__state.params.length = 0;
    expect(await setTeamPlan(9, 'free', 0, client)).toBeNull();
    expect(ran(/INSERT INTO team_plans/)).toBe(false);
  });

  it('adjustTeamTokens never goes below zero', async () => {
    pool.__state.queryImpl = async (sql) => (/SELECT tokens FROM team_token_balances/.test(sql) ? { rows: [{ tokens: 100 }] } : { rows: [] });
    expect(await adjustTeamTokens(9, 50, client)).toEqual({ before: 100, after: 150 });
    await expect(adjustTeamTokens(9, -500, client)).rejects.toMatchObject({ status: 400 });
  });
});

describe('/api/teams (user)', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/teams', require('../src/routes/teams'));
    return a;
  };
  const authed = (extra) => {
    pool.__state.queryImpl = async (sql, params) => {
      if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
      return (extra && (await extra(sql, params))) || { rows: [] };
    };
  };

  it('creates a team with the caller as owner', async () => {
    authed(async (sql) => (/INSERT INTO teams/.test(sql) ? { rows: [{ id: 12, name: 'Crew' }] } : null));
    const res = await request(app()).post('/api/teams').set('Authorization', `Bearer ${sign(5)}`).send({ name: 'Crew' });
    expect(res.status).toBe(201);
    expect(paramsOf(/INSERT INTO team_members/)).toEqual([12, 5, 'owner']);
  });

  it('only the owner can add members or set limits', async () => {
    authed(async (sql) => (/FROM team_members m JOIN teams t/.test(sql)
      ? { rows: [{ id: 12, name: 'Crew', owner_user_id: 1, role: 'member', daily_limit: null }] } : null));
    const add = await request(app()).post('/api/teams/members').set('Authorization', `Bearer ${sign(6)}`).send({ email: 'x@y.z' });
    expect(add.status).toBe(403);
    const lim = await request(app()).put('/api/teams/members/7/limit').set('Authorization', `Bearer ${sign(6)}`).send({ daily_limit: 5 });
    expect(lim.status).toBe(403);
  });

  it('owner sets and clears a member daily limit; rejects junk', async () => {
    authed(async (sql) => {
      if (/FROM team_members m JOIN teams t/.test(sql)) return { rows: [{ id: 12, name: 'Crew', owner_user_id: 5, role: 'owner', daily_limit: null }] };
      if (/UPDATE team_members SET daily_limit/.test(sql)) return { rows: [{ user_id: 7 }] };
      return null;
    });
    const ok = await request(app()).put('/api/teams/members/7/limit').set('Authorization', `Bearer ${sign(5)}`).send({ daily_limit: 500000 });
    expect(ok.status).toBe(200);
    expect(paramsOf(/UPDATE team_members SET daily_limit/)).toEqual([12, 7, 500000]);
    const clear = await request(app()).put('/api/teams/members/7/limit').set('Authorization', `Bearer ${sign(5)}`).send({ daily_limit: null });
    expect(clear.body.daily_limit).toBeNull();
    const bad = await request(app()).put('/api/teams/members/7/limit').set('Authorization', `Bearer ${sign(5)}`).send({ daily_limit: -3 });
    expect(bad.status).toBe(400);
  });
});

describe('/api/admin/teams', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/admin', require('../src/routes/admin'));
    return a;
  };
  const ADMIN = sign(21, 'admin');
  const adminDb = (extra) => {
    pool.__state.queryImpl = async (sql, params) => {
      if (/SELECT token_version, banned/.test(sql)) return { rows: [{ token_version: 0, banned: false }] };
      if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: 'admin' }] };
      if (/SELECT status FROM teams WHERE id = \$1/.test(sql)) return { rows: [{ status: 'active' }] };
      return (extra && (await extra(sql, params))) || { rows: [] };
    };
  };

  it('gives a team a plan for N days, audited', async () => {
    adminDb(async (sql) => (/plan_type = \$2/.test(sql) && /SELECT plan_type/.test(sql) ? { rows: [{ plan_type: 'pro', expires_at: 'x' }] } : null));
    const res = await request(app()).put('/api/admin/teams/9/plan').set('Authorization', `Bearer ${ADMIN}`).send({ plan: 'pro', days: 14 });
    expect(res.status).toBe(200);
    expect(paramsOf(/INSERT INTO team_plans/)).toEqual([9, 'pro', 14]);
    expect(paramsOf(/INSERT INTO admin_audit_log/)[1]).toBe('team.plan');
  });

  it('adds tokens to a team pot, audited; reason required', async () => {
    adminDb(async (sql) => (/SELECT tokens FROM team_token_balances/.test(sql) ? { rows: [{ tokens: 0 }] } : null));
    const noReason = await request(app()).post('/api/admin/teams/9/tokens').set('Authorization', `Bearer ${ADMIN}`).send({ delta_tokens: 1000 });
    expect(noReason.status).toBe(400);
    const res = await request(app()).post('/api/admin/teams/9/tokens').set('Authorization', `Bearer ${ADMIN}`).send({ delta_tokens: 1000, reason: 'launch gift' });
    expect(res.status).toBe(200);
    expect(res.body.tokens).toBe(1000);
    expect(paramsOf(/INSERT INTO admin_audit_log/)[1]).toBe('team.tokens');
  });
});
