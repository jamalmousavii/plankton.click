// Subscription plans + token bundles (v3.39.1).
//
// Free: every subject (signed-in user or guest, tracked by IP) gets a daily
// token allowance. Paid plans raise that allowance for 30 days; token bundles
// are a non-expiring prepaid token pot. Marginal serving cost is ~0 (our own
// Ollama + worker network), so pricing follows market value, not token cost.
const pool = require('../database/pool');
const MODELS = require('../models');

const FREE_DAILY_TOKENS = 2000000;
const DEFAULT_MODEL_ID = 'llama3.1:8b';
// The ONE fallback price in the codebase (v3.45.0): an unknown model id
// resolves here — chat/v1 used to carry three divergent literals
// (0.158/0.176/0.188) for the same case.
// Conservative (= the highest catalog output price), so an unknown id can
// never be served below cost.
const DEFAULT_OUTPUT_PRICE = 0.28;
// Hard per-task output-token bound (H1). tokens_used drives both the user
// charge and the worker share, so an inflated or NaN report must fail the
// task — never be clamped into a charge. Shared by routes/chat.js,
// routes/v1.js and the WS task-result handler (v3.45.0).
const MAX_TASK_TOKENS = 65536;

// Paid tiers. One row per tier in user_plans; a user may hold several active
// rows and always gets the biggest cap among them.
const PLANS = {
  // Priced under the cheapest mainstream AI plans (ChatGPT Go $8, Gemini
  // entry $4.99 — Oct 2026) so open models win on price.
  plus: { name: 'plus', label: 'Plus', price: 2.99, daily_tokens: 10000000, interval_days: 30 },
  pro: { name: 'pro', label: 'Pro', price: 5.99, daily_tokens: 30000000, interval_days: 30 },
  max: { name: 'max', label: 'Max', price: 11.99, daily_tokens: 80000000, interval_days: 30 },
};

// Token bundle: whole dollars in, no expiry. A pot token is worth one output
// token of the default model, so $1 buys exactly what $1 of wallet does
// (bigger models drain proportionally more — see potTokensFor). It used to be
// a flat $1 = 1M tokens, ~6x worse than paying from the wallet.
const TOKEN_BUNDLE = {
  tokens_per_usd: Math.round(1e6 / modelOutputPrice(DEFAULT_MODEL_ID)),
  price_per_million: modelOutputPrice(DEFAULT_MODEL_ID),
  min_usd: 1,
  max_usd: 500,
};

// Flat worker share on every paid leg (wallet debit and token-pot spend).
// Free legs (daily allowance, $1 worker credit) are platform-funded and pay
// workers nothing — unchanged since v3.25.0/v3.27.0.
const WORKER_REVENUE_SHARE = 0.9;

// Single source of truth for output pricing (v3.45.0): chat, the v1 agent
// API and the WS result handler all resolve through here.
function modelOutputPrice(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  return m ? m.outputPrice : DEFAULT_OUTPUT_PRICE;
}

// Embedding requests have no output text: they are priced on their INPUT
// tokens at the model's catalog input price (same fallback rule).
const DEFAULT_INPUT_PRICE = 0.079;
function modelInputPrice(modelId) {
  const m = MODELS.find((x) => x.id === modelId);
  return m ? m.inputPrice : DEFAULT_INPUT_PRICE;
}

// What a day's allowance is worth at the default model's catalog output
// price — used to show "N tokens/day (≈ $X/day, $Y/month worth)".
function outputPrice() {
  return modelOutputPrice(DEFAULT_MODEL_ID);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function tokenValueUsd(tokens, price = outputPrice()) {
  const day = (tokens * price) / 1e6;
  return { value_usd_day: round2(day), value_usd_month: round2(day * 30) };
}

// Public catalog with value metrics attached (for GET /api/plans, the 402
// wall and the upgrade notice).
function listPlans() {
  const price = outputPrice();
  return Object.values(PLANS).map((p) => ({
    name: p.name,
    label: p.label,
    price: p.price,
    daily_tokens: p.daily_tokens,
    interval_days: p.interval_days,
    ...tokenValueUsd(p.daily_tokens, price),
  }));
}

// Pot tokens a message costs: its catalog USD cost expressed in default-model
// output tokens (>= 1 for any non-free message).
function potTokensFor(costUsd) {
  return Math.max(1, Math.ceil((costUsd * 1e6) / modelOutputPrice(DEFAULT_MODEL_ID) - 1e-9));
}

function quoteTokens(amountUsd) {
  return Math.round(amountUsd * TOKEN_BUNDLE.tokens_per_usd);
}

// Active = status 'active' AND not expired. If several tiers are active at
// once (bought Plus, later bought Pro) the biggest cap wins; the smaller row
// simply runs out on its own — no proration, no downgrade.
async function getActivePlan(userId, client = pool) {
  if (!userId) return null;
  const r = await client.query(
    `SELECT plan_type, expires_at FROM user_plans
      WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
    [userId]
  );
  const rows = (r.rows || []).filter((row) => PLANS[row.plan_type]);
  if (!rows.length) return null;
  rows.sort((a, b) => PLANS[b.plan_type].daily_tokens - PLANS[a.plan_type].daily_tokens);
  return rows[0];
}

// Daily cap for the subject: the best active plan, else the Free allowance.
async function getDailyCap(userId, client = pool) {
  const plan = await getActivePlan(userId, client);
  return plan ? PLANS[plan.plan_type].daily_tokens : FREE_DAILY_TOKENS;
}

// Called exactly once per confirmed invoice (claimed via plan_purchases
// before this runs), inside the caller's transaction.
async function activatePlan(userId, tier, client = pool) {
  const p = PLANS[tier];
  if (!p) throw new Error(`Unknown plan tier: ${tier}`);
  await client.query(
    `INSERT INTO user_plans (user_id, plan_type, status, started_at, expires_at)
          VALUES ($1, $2, 'active', now(), now() + ($3::int * interval '1 day'))
     ON CONFLICT (user_id, plan_type) DO UPDATE
        SET status = 'active',
            started_at = COALESCE(user_plans.started_at, now()),
            expires_at = GREATEST(COALESCE(user_plans.expires_at, now()), now())
                       + ($3::int * interval '1 day')`,
    [userId, tier, p.interval_days]
  );
}

module.exports = {
  FREE_DAILY_TOKENS,
  PLANS,
  TOKEN_BUNDLE,
  WORKER_REVENUE_SHARE,
  MAX_TASK_TOKENS,
  modelOutputPrice,
  modelInputPrice,
  potTokensFor,
  listPlans,
  quoteTokens,
  tokenValueUsd,
  getActivePlan,
  getDailyCap,
  activatePlan,
};
