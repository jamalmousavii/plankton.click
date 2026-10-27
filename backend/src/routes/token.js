const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { logger } = require('../logger');
const { getWorkerCreditStatus } = require('../services/workerCredit');
const { FREE_DAILY_TOKENS, PLANS, TOKEN_BUNDLE, listPlans, getActivePlan } = require('../services/plans');
const { getFreeStatus } = require('../services/freeAllowance');
const { getTokenBalance } = require('../services/tokenBundles');

// GET /api/token/balance — USD balance snapshot for the signed-in user.
// Auth is enforced by `authenticate` mounted in server.js, so req.user is set.
router.get('/balance', async (req, res) => {
  try {
    const userId = req.user.id;

    const balanceResult = await pool.query(
      `SELECT COALESCE(available, 0) as available, COALESCE(total_earned, 0) as total_earned, COALESCE(total_spent, 0) as total_spent
       FROM user_coin_balances WHERE user_id = $1 AND coin = 'USD'`,
      [userId]
    );

    const balance = balanceResult.rows[0] || { available: 0, total_earned: 0, total_spent: 0 };
    const workerCredit = await getWorkerCreditStatus(userId);
    const plan = await getActivePlan(userId);
    const cap = plan ? PLANS[plan.plan_type].daily_tokens : FREE_DAILY_TOKENS;
    const freeStatus = await getFreeStatus({ userId, cap });
    const tokenBalance = await getTokenBalance(userId);

    res.json({
      success: true,
      available: parseFloat(balance.available),
      total_earned: parseFloat(balance.total_earned),
      total_spent: parseFloat(balance.total_spent),
      worker_credit: {
        eligible: workerCredit.eligible,
        limit: workerCredit.limit,
        used: workerCredit.used,
        remaining: workerCredit.remaining,
      },
      free_tokens: {
        limit: freeStatus.limit,
        used: freeStatus.used,
        remaining: freeStatus.remaining,
      },
      plan: plan
        ? { name: plan.plan_type, active: true, expires_at: plan.expires_at }
        : { name: 'free', active: false, expires_at: null },
      plans: listPlans(),
      token_bundle: {
        price_per_million: TOKEN_BUNDLE.price_per_million,
        tokens_per_usd: TOKEN_BUNDLE.tokens_per_usd,
        min_usd: TOKEN_BUNDLE.min_usd,
        max_usd: TOKEN_BUNDLE.max_usd,
        balance: tokenBalance,
      },
    });

  } catch (err) {
    logger.error({ err }, 'GET /api/token/balance failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// Legacy self-service ledger endpoints. They let any signed-in user mint an
// arbitrary balance (deposit self-confirms without any chain verification) or
// move funds without any economic check, and nothing in the app calls them:
// balances are funded exclusively through NowPayments (/api/payments).
const gone = (name) => (req, res) => {
  res.status(410).json({
    error: `${name} is no longer supported. Fund your wallet with POST /api/payments/deposit/create.`,
  });
};

router.post('/deposit', gone('POST /api/token/deposit'));
router.post('/deduct', gone('POST /api/token/deduct'));
router.post('/transfer', gone('POST /api/token/transfer'));

module.exports = router;
