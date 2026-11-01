// Teams: a shared account that owns its own plan and token pot.
//
// A member's message is paid, in order, from:
//   1. the team's daily plan allowance (team_daily_usage vs the plan cap),
//   2. the team's token pot (team_token_balances),
//   3. the member's personal coverage (free/plan allowance, worker credit,
//      personal pot, wallet — services/billing.js).
// Both team legs respect the member's optional per-UTC-day daily_limit
// (team_member_daily). All amounts are model-weighted tokens
// (plans.weightedTokensFor), the same unit as the personal allowance.
const pool = require('../database/pool');
const { getDailyCap, PLANS } = require('./plans');

const UTC_TODAY = `(now() AT TIME ZONE 'utc')::date`;

// Personal daily cap + whose allowance row to charge (the user's own;
// guests by IP). Teams no longer lend their owner's personal plan — a team
// pays from its own plan and pot (chargeTeam) before this applies.
async function resolveCap(userId, guestKey, client = pool) {
  const cap = await getDailyCap(userId, client);
  return { cap, bucketUserId: userId || null };
}

async function getActiveTeam(userId, client = pool) {
  if (!userId) return null;
  const r = await client.query(
    `SELECT t.id, t.name, t.owner_user_id, m.role, m.daily_limit
       FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'`,
    [userId]
  );
  return r.rows[0] || null;
}

// Best active team plan (biggest cap wins, like personal plans).
async function getActiveTeamPlan(teamId, client = pool) {
  const r = await client.query(
    `SELECT plan_type, expires_at FROM team_plans
      WHERE team_id = $1 AND status = 'active' AND expires_at > now()`,
    [teamId]
  );
  let best = null;
  for (const row of r.rows) {
    const p = PLANS[row.plan_type];
    if (p && (!best || p.daily_tokens > PLANS[best.plan_type].daily_tokens)) best = row;
  }
  return best;
}

// Read-only snapshot: plan, today's team usage vs cap, pot.
async function getTeamStatus(teamId, client = pool) {
  const plan = await getActiveTeamPlan(teamId, client);
  const cap = plan ? PLANS[plan.plan_type].daily_tokens : 0;
  const used = await client.query(
    `SELECT CASE WHEN last_reset_date = ${UTC_TODAY} THEN tokens_used_today ELSE 0 END AS used
       FROM team_daily_usage WHERE team_id = $1`,
    [teamId]
  );
  const pot = await client.query('SELECT tokens FROM team_token_balances WHERE team_id = $1', [teamId]);
  const usedToday = Number(used.rows[0]?.used || 0);
  return {
    plan: plan ? { plan_type: plan.plan_type, expires_at: plan.expires_at, daily_tokens: cap } : null,
    used_today: usedToday,
    remaining_today: Math.max(0, cap - usedToday),
    tokens: Number(pot.rows[0]?.tokens || 0),
  };
}

async function getMemberUsedToday(teamId, userId, client = pool) {
  const r = await client.query(
    `SELECT CASE WHEN last_reset_date = ${UTC_TODAY} THEN tokens_used_today ELSE 0 END AS used
       FROM team_member_daily WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  return Number(r.rows[0]?.used || 0);
}

// Pre-flight (read-only): can the team pay at least something for this
// member right now?
async function teamHasCoverage(userId, client = pool) {
  const team = await getActiveTeam(userId, client);
  if (!team) return false;
  if (team.daily_limit !== null && team.daily_limit !== undefined) {
    if (await getMemberUsedToday(team.id, userId, client) >= Number(team.daily_limit)) return false;
  }
  const st = await getTeamStatus(team.id, client);
  return st.remaining_today > 0 || st.tokens > 0;
}

// Charge `weighted` tokens to the member's team inside the caller's billing
// transaction. Row-locked, all-or-nothing per leg (plan allowance, then pot).
// Returns { charged: 'plan' | 'tokens' | null, teamId, planType }.
async function chargeTeam({ userId, weighted, client }) {
  const team = await getActiveTeam(userId, client);
  if (!team || !(weighted > 0)) return { charged: null };

  // Member daily limit: lock + roll the member's row, refuse past the limit.
  const mem = await client.query(
    `INSERT INTO team_member_daily (team_id, user_id, tokens_used_today, last_reset_date)
          VALUES ($1, $2, 0, ${UTC_TODAY})
     ON CONFLICT (team_id, user_id) DO UPDATE
        SET tokens_used_today = CASE WHEN team_member_daily.last_reset_date = ${UTC_TODAY}
                                     THEN team_member_daily.tokens_used_today ELSE 0 END,
            last_reset_date = ${UTC_TODAY}
     RETURNING tokens_used_today`,
    [team.id, userId]
  );
  const memberUsed = Number(mem.rows[0].tokens_used_today) || 0;
  if (team.daily_limit !== null && team.daily_limit !== undefined
      && memberUsed + weighted > Number(team.daily_limit)) {
    return { charged: null, teamId: team.id, limited: true };
  }
  const recordMember = () => client.query(
    'UPDATE team_member_daily SET tokens_used_today = tokens_used_today + $3 WHERE team_id = $1 AND user_id = $2',
    [team.id, userId, weighted]
  );

  // 1) Team plan allowance.
  const plan = await getActiveTeamPlan(team.id, client);
  if (plan) {
    const cap = PLANS[plan.plan_type].daily_tokens;
    const day = await client.query(
      `INSERT INTO team_daily_usage (team_id, tokens_used_today, last_reset_date)
            VALUES ($1, 0, ${UTC_TODAY})
       ON CONFLICT (team_id) DO UPDATE
          SET tokens_used_today = CASE WHEN team_daily_usage.last_reset_date = ${UTC_TODAY}
                                       THEN team_daily_usage.tokens_used_today ELSE 0 END,
              last_reset_date = ${UTC_TODAY}
       RETURNING tokens_used_today`,
      [team.id]
    );
    const used = Number(day.rows[0].tokens_used_today) || 0;
    if (used + weighted <= cap) {
      await client.query(
        'UPDATE team_daily_usage SET tokens_used_today = tokens_used_today + $2 WHERE team_id = $1',
        [team.id, weighted]
      );
      await recordMember();
      return { charged: 'plan', teamId: team.id, planType: plan.plan_type };
    }
  }

  // 2) Team token pot.
  const pot = await client.query(
    `UPDATE team_token_balances SET tokens = tokens - $2, updated_at = now()
      WHERE team_id = $1 AND tokens >= $2 RETURNING tokens`,
    [team.id, weighted]
  );
  if (pot.rows.length > 0) {
    await recordMember();
    return { charged: 'tokens', teamId: team.id, remaining: Number(pot.rows[0].tokens) };
  }
  return { charged: null, teamId: team.id };
}

// SET the team's plan: other active tiers are cancelled, the chosen one runs
// `days` from now; plan 'free' just cancels.
async function setTeamPlan(teamId, plan, days, client) {
  await client.query(
    `UPDATE team_plans SET status = 'cancelled' WHERE team_id = $1 AND status = 'active' AND plan_type <> $2`,
    [teamId, plan]
  );
  if (plan === 'free') {
    await client.query(`UPDATE team_plans SET status = 'cancelled' WHERE team_id = $1 AND status = 'active'`, [teamId]);
    return null;
  }
  await client.query(
    `INSERT INTO team_plans (team_id, plan_type, status, started_at, expires_at)
          VALUES ($1, $2, 'active', now(), now() + ($3::int * interval '1 day'))
     ON CONFLICT (team_id, plan_type) DO UPDATE
        SET status = 'active', started_at = now(), expires_at = now() + ($3::int * interval '1 day')`,
    [teamId, plan, days]
  );
  const r = await client.query(
    `SELECT plan_type, expires_at FROM team_plans WHERE team_id = $1 AND plan_type = $2`,
    [teamId, plan]
  );
  return r.rows[0] || null;
}

// Add (or remove, negative) tokens to the team pot; never below zero.
async function adjustTeamTokens(teamId, delta, client) {
  const cur = await client.query('SELECT tokens FROM team_token_balances WHERE team_id = $1 FOR UPDATE', [teamId]);
  const before = cur.rows.length ? Number(cur.rows[0].tokens) || 0 : 0;
  const after = before + delta;
  if (after < 0) throw Object.assign(new Error('Team token balance would go negative'), { status: 400 });
  await client.query(
    `INSERT INTO team_token_balances (team_id, tokens, total_added) VALUES ($1, $2, GREATEST($3, 0))
     ON CONFLICT (team_id) DO UPDATE
        SET tokens = $2, total_added = team_token_balances.total_added + GREATEST($3, 0), updated_at = now()`,
    [teamId, after, delta]
  );
  return { before, after };
}

// Members with today's team usage, their limit and 30-day totals.
async function getTeamMembers(teamId, client = pool) {
  const r = await client.query(
    `SELECT u.id, u.email, u.name, m.role, m.joined_at, m.daily_limit,
            CASE WHEN d.last_reset_date = ${UTC_TODAY} THEN COALESCE(d.tokens_used_today, 0) ELSE 0 END AS used_today,
            COALESCE(us.tokens, 0)::bigint AS tokens_30d, COALESCE(us.messages, 0)::int AS messages_30d,
            COALESCE(us.cost, 0) AS cost_30d
       FROM team_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN team_member_daily d ON d.team_id = m.team_id AND d.user_id = m.user_id
       LEFT JOIN LATERAL (
            SELECT SUM(t.tokens_used) AS tokens, COUNT(*) AS messages, SUM(t.cost) AS cost
              FROM tasks t
             WHERE t.user_id = u.id AND t.status = 'completed' AND t.created_at > now() - interval '30 days'
       ) us ON true
      WHERE m.team_id = $1 AND m.status = 'active'
      ORDER BY (m.role = 'owner') DESC, m.joined_at ASC`,
    [teamId]
  );
  return r.rows;
}

async function addMember(teamId, userId, role = 'member', client = pool) {
  // The partial unique index uniq_team_members_active_user (one ACTIVE team
  // per user) is the race guard; map its violation to a friendly error.
  try {
    await client.query(
      `INSERT INTO team_members (team_id, user_id, role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (team_id, user_id) DO UPDATE SET status = 'active', role = EXCLUDED.role`,
      [teamId, userId, role]
    );
  } catch (err) {
    if (err.code === '23505') {
      throw Object.assign(new Error('User already belongs to an active team'), { status: 400 });
    }
    throw err;
  }
}

async function removeMember(teamId, userId, client = pool) {
  const r = await client.query(
    `UPDATE team_members SET status = 'removed' WHERE team_id = $1 AND user_id = $2 AND status = 'active'`,
    [teamId, userId]
  );
  return r.rowCount;
}

module.exports = {
  resolveCap,
  getActiveTeam,
  getActiveTeamPlan,
  getTeamStatus,
  getMemberUsedToday,
  teamHasCoverage,
  chargeTeam,
  setTeamPlan,
  adjustTeamTokens,
  getTeamMembers,
  addMember,
  removeMember,
};
