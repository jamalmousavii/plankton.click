const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate, optionalAuth } = require('../middleware/auth');
const nowpayments = require('../services/nowpayments');
const {
  FREE_DAILY_TOKENS,
  PLANS,
  TOKEN_BUNDLE,
  listPlans,
  quoteTokens,
  getActivePlan,
} = require('../services/plans');
const { getFreeStatus } = require('../services/freeAllowance');
const { getTokenBalance } = require('../services/tokenBundles');
const { logger } = require('../logger');

// Auth is optional on the snapshot: pricing/caps are public, the personal
// allowance block only appears with a valid token. Uses the shared middleware
// optionalAuth (v3.29.1) — an expired/garbage Bearer degrades to anonymous
// instead of 401ing the public catalog.

// GET /api/plans — plan catalog + token-bundle quote + public pricing.
router.get('/', optionalAuth, async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const plan = userId ? await getActivePlan(userId) : null;
    const cap = plan ? PLANS[plan.plan_type].daily_tokens : FREE_DAILY_TOKENS;

    const body = {
      success: true,
      plans: listPlans(),
      plan: plan
        ? { name: plan.plan_type, active: true, expires_at: plan.expires_at }
        : { name: 'free', active: false, expires_at: null },
      daily_limit: cap,
      token_bundle: {
        price_per_million: TOKEN_BUNDLE.price_per_million,
        tokens_per_usd: TOKEN_BUNDLE.tokens_per_usd,
        min_usd: TOKEN_BUNDLE.min_usd,
        max_usd: TOKEN_BUNDLE.max_usd,
      },
    };
    if (userId) {
      const freeStatus = await getFreeStatus({ userId, cap });
      body.free_tokens = {
        limit: freeStatus.limit,
        used: freeStatus.used,
        remaining: freeStatus.remaining,
      };
      body.token_balance = await getTokenBalance(userId);
    }
    res.json(body);
  } catch (err) {
    logger.error({ err }, 'GET /api/plans failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/plans/tokens/purchase — prepaid token pot, whole dollars.
// Defined before /:tier/purchase so 'tokens' can never be read as a tier.
router.post('/tokens/purchase', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const amountUsd = Number(req.body?.amount_usd);

    if (!Number.isInteger(amountUsd)) {
      return res.status(400).json({ error: 'amount_usd must be a whole dollar amount' });
    }
    const minUsd = Math.max(TOKEN_BUNDLE.min_usd, nowpayments.getMinUsdDeposit());
    if (amountUsd < minUsd || amountUsd > TOKEN_BUNDLE.max_usd) {
      return res
        .status(400)
        .json({ error: `amount_usd must be between $${minUsd} and $${TOKEN_BUNDLE.max_usd}` });
    }

    const tokens = quoteTokens(amountUsd);
    // Double-click / duplicate-tab guard (v3.45.0): one live token invoice per
    // user at a time; the client also disables its buy button.
    const recent = await pool.query(
      `SELECT 1 FROM plan_purchases
        WHERE user_id = $1 AND plan_type = 'tokens' AND status = 'pending'
          AND created_at > NOW() - INTERVAL '90 seconds'
        LIMIT 1`,
      [userId]
    );
    if (recent.rows.length > 0) {
      return res.status(409).json({
        error: 'A token purchase is already in progress — finish the open invoice or retry in a minute.',
        code: 'purchase_pending',
      });
    }
    const orderId = `tok-${userId}-${Date.now()}`;
    // B4: the pending row must exist BEFORE the invoice does. An invoice with
    // no local row means the later IPN deduped against nothing — paid, never
    // credited. A failed row insert now aborts before any invoice is created.
    await pool.query(
      `INSERT INTO plan_purchases (order_id, user_id, invoice_id, amount, plan_type, tokens, status)
       VALUES ($1, $2, NULL, $3, 'tokens', $4, 'pending')`,
      [orderId, userId, amountUsd, tokens]
    );

    const result = await nowpayments.createInvoice({
      userId,
      amount: amountUsd,
      orderId,
      description: `Plankton token bundle - ${tokens.toLocaleString('en-US')} tokens (never expires)`,
    });

    if (!result.success) {
      await pool.query(
        `UPDATE plan_purchases SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`,
        [orderId]
      ).catch((err) => logger.error({ err, orderId }, 'Failed to mark purchase failed'));
      logger.error({ err: result.error }, 'Plan invoice creation failed');
      return res.status(500).json({ error: 'Invoice creation failed' });
    }

    await pool.query(
      `UPDATE plan_purchases SET invoice_id = $2 WHERE order_id = $1`,
      [orderId, result.invoiceId ? String(result.invoiceId) : null]
    ).catch((err) => logger.error({ err, orderId }, 'Failed to store invoice_id'));

    res.status(201).json({
      success: true,
      invoice: {
        id: result.invoiceId,
        url: result.invoiceUrl,
        order_id: orderId,
        amountUsd,
        tokens,
      },
    });
  } catch (err) {
    logger.error({ err }, 'POST /api/plans/tokens/purchase failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/plans/:tier/purchase — create the monthly plan invoice.
// Activation happens in the IPN webhook (plan_purchases claim keeps it
// exactly-once even if NowPayments replays the 'finished' notification).
router.post('/:tier/purchase', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const tier = String(req.params.tier).toLowerCase();
    const plan = PLANS[tier];
    if (!plan) {
      return res.status(400).json({ error: 'Unknown plan tier', code: 'INVALID_PLAN' });
    }

    const orderId = `${tier}-${userId}-${Date.now()}`;
    // Double-click / duplicate-tab guard (v3.45.0): one live invoice per
    // user+tier at a time (see /tokens/purchase above).
    const recent = await pool.query(
      `SELECT 1 FROM plan_purchases
        WHERE user_id = $1 AND plan_type = $2 AND status = 'pending'
          AND created_at > NOW() - INTERVAL '90 seconds'
        LIMIT 1`,
      [userId, tier]
    );
    if (recent.rows.length > 0) {
      return res.status(409).json({
        error: `A ${tier} purchase is already in progress — finish the open invoice or retry in a minute.`,
        code: 'purchase_pending',
      });
    }
    // B4: pending row first — see the note in /tokens/purchase above.
    await pool.query(
      `INSERT INTO plan_purchases (order_id, user_id, invoice_id, amount, plan_type, status)
       VALUES ($1, $2, NULL, $3, $4, 'pending')`,
      [orderId, userId, plan.price, tier]
    );

    const result = await nowpayments.createInvoice({
      userId,
      amount: plan.price,
      orderId,
      description: `Plankton ${plan.label} plan - ${plan.interval_days} days (${plan.daily_tokens.toLocaleString('en-US')} tokens/day)`,
    });

    if (!result.success) {
      await pool.query(
        `UPDATE plan_purchases SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`,
        [orderId]
      ).catch((err) => logger.error({ err, orderId }, 'Failed to mark purchase failed'));
      logger.error({ err: result.error }, 'Plan invoice creation failed');
      return res.status(500).json({ error: 'Invoice creation failed' });
    }

    await pool.query(
      `UPDATE plan_purchases SET invoice_id = $2 WHERE order_id = $1`,
      [orderId, result.invoiceId ? String(result.invoiceId) : null]
    ).catch((err) => logger.error({ err, orderId }, 'Failed to store invoice_id'));

    res.status(201).json({
      success: true,
      invoice: {
        id: result.invoiceId,
        url: result.invoiceUrl,
        order_id: orderId,
        amountUsd: plan.price,
        plan: tier,
      },
    });
  } catch (err) {
    logger.error({ err }, 'POST /api/plans/:tier/purchase failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
