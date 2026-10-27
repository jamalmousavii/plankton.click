const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate } = require('../middleware/auth');
const nowpayments = require('../services/nowpayments');
const { getWorkerCreditStatus } = require('../services/workerCredit');
const { FREE_DAILY_TOKENS, PLANS, TOKEN_BUNDLE, listPlans, getActivePlan } = require('../services/plans');
const { getTokenBalance } = require('../services/tokenBundles');
const { applyPlanPurchase, applyDeposit } = require('../services/paymentClaims');
const { getFreeStatus } = require('../services/freeAllowance');
const { invalidateCache } = require('../cache');
const { logger } = require('../logger');

// GET /api/payments/coins — still returns coin list for invoice display
router.get('/coins', (req, res) => {
  const coins = nowpayments.getSupportedCoins();
  res.json({ success: true, coins });
});

// POST /api/payments/deposit/create — create USD invoice (customer picks coin on NP page)
router.post('/deposit/create', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    // Accept amount_usd or amount (legacy)
    const amount = parseFloat(req.body.amount_usd ?? req.body.amount);

    if (!amount || amount <= 0 || Number.isNaN(amount)) {
      return res.status(400).json({ error: 'amount_usd required' });
    }

    const minUsd = nowpayments.getMinUsdDeposit();
    if (amount < minUsd) {
      return res.status(400).json({ error: `Minimum deposit is $${minUsd} USD` });
    }
    // Cap single invoice to bound provider fees and fat-finger mistakes.
    const MAX_DEPOSIT_USD = 10000;
    if (amount > MAX_DEPOSIT_USD) {
      return res.status(400).json({ error: `Maximum deposit is $${MAX_DEPOSIT_USD} USD per invoice` });
    }

    // Optional coin pre-select (customer can still change on NP page)
    const coin = req.body.coin ? String(req.body.coin).toUpperCase() : undefined;
    if (coin && !nowpayments.getSupportedCoins()[coin]) {
      return res.status(400).json({ error: `Unsupported coin: ${coin}` });
    }

    // B4: pending row BEFORE the invoice. order_id is the IPN correlation key
    // and is generated up front; if the insert fails we abort before any live
    // invoice exists (an invoice with no local row = IPN credits nothing), and
    // if invoice creation fails the row is marked 'failed' instead of lingering.
    // randomUUID suffix avoids same-ms double-click collisions on UNIQUE(order_id).
    const { randomUUID } = require('crypto');
    const orderId = `plankton-${userId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO coin_deposits (user_id, coin, amount, order_id, status)
       VALUES ($1, 'USD', $2, $3, 'pending')`,
      [userId, amount, orderId]
    );

    const result = await nowpayments.createInvoice({
      userId,
      coin,
      amount,
      orderId,
    });

    if (!result.success) {
      await pool.query(
        `UPDATE coin_deposits SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`,
        [orderId]
      ).catch((err) => logger.error({ err, orderId }, 'Failed to mark deposit failed'));
      logger.error({ orderId, err: result.error }, 'NowPayments invoice creation failed');
      // Never forward provider error bodies to the client (plan LOW: NP error text).
      return res.status(500).json({ error: 'Invoice creation failed' });
    }

    await pool.query(
      `UPDATE coin_deposits SET processor_id = $2 WHERE order_id = $1`,
      [orderId, result.invoiceId]
    ).catch((err) => logger.error({ err, orderId }, 'Failed to store processor_id'));

    res.status(201).json({
      success: true,
      invoice: {
        id: result.invoiceId,
        url: result.invoiceUrl,
        payAddress: result.payAddress,
        payAmount: result.payAmount,
        amountUsd: amount,
      }
    });

  } catch (err) {
    logger.error({ err }, 'POST /api/payments/deposit/create failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/payments/deposit/webhook — NowPayments IPN
router.post('/deposit/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const payload = req.body;

    // B2: verify against the exact bytes that were signed (captured pre-parse
    // by express.json's verify hook), falling back to the sorted-JSON
    // canonicalisation inside verifyIPN.
    if (!nowpayments.verifyIPN(payload, signature, req.rawBody)) {
      logger.error('Rejected IPN: invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const result = await nowpayments.processIPN(payload);
    // processIPN returns success only for payment_status 'finished' (its
    // normalized `status` is 'completed') — gate on success alone; checking
    // `status !== 'finished'` here (v3.18.0) ignored every finished IPN.
    if (!result.success) {
      return res.json({ status: 'ignored', payment_status: result.status });
    }

    const { userId, amount, txHash, orderId, invoiceId, cryptoCoin } = result;

    if (!userId || !(amount > 0)) {
      return res.json({ status: 'ignored', reason: 'invalid payload' });
    }

    // Paid order ids: "<tier>-…" (v3.28.0). Plan tiers activate the
    // subscription; 'tok' credits the prepaid token pot; wallet deposits keep
    // the legacy "plankton-…" prefix. The UPDATE-while-pending claim (now in
    // services/paymentClaims.js) keeps replays exactly-once — a second
    // 'finished' IPN can never extend or credit twice. B4: the webhook and the
    // nightly reconciler share those helpers so both apply money identically.
    const orderPrefix = (orderId || '').split('-')[0];
    if (orderId && (orderPrefix === 'tok' || PLANS[orderPrefix])) {
      const { deduped } = await applyPlanPurchase({ userId, orderId, txHash });
      return res.json(deduped ? { status: 'ok', deduped: true } : { status: 'ok' });
    }

    const { deduped } = await applyDeposit({ userId, orderId, invoiceId, txHash, cryptoCoin });
    return res.json(deduped ? { status: 'ok', deduped: true } : { status: 'ok' });
  } catch (err) {
    logger.error({ err }, 'IPN webhook error');
    if (!process.env.NOWPAYMENTS_IPN_SECRET) {
      return res.status(503).json({ error: 'Payment webhook not configured (missing IPN secret)' });
    }
    // Non-2xx makes NowPayments retry — correct for transient DB failures.
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/payments/balance — USD balance only
router.get('/balance', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      "SELECT available, total_earned, total_spent FROM user_coin_balances WHERE user_id = $1 AND coin = 'USD'",
      [userId]
    );

    const row = result.rows[0];
    // F2: settings needs to know whether to show the set- or change-password
    // form (boolean only — never the hash).
    const userRow = await pool.query(
      'SELECT password IS NOT NULL AS has_password FROM users WHERE id = $1',
      [userId]
    );
    const workerCredit = await getWorkerCreditStatus(userId);
    const plan = await getActivePlan(userId);
    const cap = plan ? PLANS[plan.plan_type].daily_tokens : FREE_DAILY_TOKENS;
    const freeStatus = await getFreeStatus({ userId, cap });
    const tokenBalance = await getTokenBalance(userId);
    const balances = {
      USD: {
        available: parseFloat(row?.available || 0),
        total_earned: parseFloat(row?.total_earned || 0),
        total_spent: parseFloat(row?.total_spent || 0),
      },
    };

    res.json({
      success: true,
      balances,
      currency: 'USD',
      has_password: userRow.rows[0]?.has_password || false,
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
    logger.error({ err }, 'Request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/payments/withdraw — USDT TRC-20 only, min $5, fee paid by sender
router.post('/withdraw', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    // Accept USD amount + TRC20 address; coin forced to USDT for payout
    const amount = parseFloat(req.body.amount);
    const toAddress = typeof req.body.toAddress === 'string' ? req.body.toAddress.trim() : '';

    if (!amount || !toAddress) {
      return res.status(400).json({ error: 'amount and toAddress required' });
    }

    if (amount < 5) {
      return res.status(400).json({ error: 'Minimum withdrawal is $5' });
    }
    const MAX_WITHDRAW_USD = 10000;
    if (!(amount <= MAX_WITHDRAW_USD)) {
      return res.status(400).json({ error: `Maximum withdrawal is $${MAX_WITHDRAW_USD} USD` });
    }
    // TRC20 base58: T + 33 chars (no 0,O,I,l). Rejects typos before provider fee burns.
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(toAddress)) {
      return res.status(400).json({ error: 'Invalid TRC20 address (expected T + 33 base58 chars)' });
    }

    // Fee paid by sender
    const fee = nowpayments.getWithdrawFee(amount);
    const totalDeduction = amount + fee;

    // H2, phase A: debit + pending withdrawal row + pending ledger row commit
    // together in one transaction. The `available >= $1` guard keeps two
    // concurrent withdrawals from overdrawing; if ANY statement fails the whole
    // txn rolls back, so money never moves without a record.
    const desc = `USD withdrawal (USDT TRC-20) to ${toAddress.slice(0, 10)}...`;
    const client = await pool.connect();
    let withdrawalId;
    let ledgerId;
    try {
      await client.query('BEGIN');
      const deducted = await client.query(
        `UPDATE user_coin_balances
            SET available = available - $1, total_spent = total_spent + $1
          WHERE user_id = $2 AND coin = 'USD' AND available >= $1
          RETURNING available`,
        [totalDeduction, userId]
      );
      if (deducted.rows.length === 0) {
        await client.query('ROLLBACK');
        const balanceResult = await pool.query(
          "SELECT available FROM user_coin_balances WHERE user_id = $1 AND coin = 'USD'",
          [userId]
        );
        const available = parseFloat(balanceResult.rows[0]?.available || 0);
        return res.status(400).json({
          error: `Insufficient balance. Need $${totalDeduction.toFixed(2)} ($${amount.toFixed(2)} + $${fee.toFixed(2)} fee), have $${available.toFixed(2)}`
        });
      }
      const pending = await client.query(
        `INSERT INTO coin_withdrawals (user_id, coin, amount, to_address, tx_hash, fee, status)
         VALUES ($1, 'USD', $2, $3, NULL, $4, 'pending')
         RETURNING id`,
        [userId, amount, toAddress, fee]
      );
      withdrawalId = pending.rows[0].id;
      const ledger = await client.query(
        `INSERT INTO transactions (from_address, to_address, amount, type, description, status)
         VALUES ($1, 'withdrawal', $2, 'usd_withdrawal', $3, 'pending')
         RETURNING id`,
        [userId, amount, desc]
      );
      ledgerId = ledger.rows[0].id;
      await client.query('COMMIT');
    } catch (phaseAErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw phaseAErr;
    } finally {
      client.release();
    }

    // H2, phase B: the external payout call — deliberately OUTSIDE any DB
    // transaction (an HTTP call inside a txn would hold locks for seconds and
    // its throw previously ate the debit: money vanished with no row at all).
    let payoutResult;
    try {
      payoutResult = await nowpayments.createPayout({
        address: toAddress,
        amount,
        coin: 'USDT',
      });
    } catch (payoutErr) {
      payoutResult = { success: false, error: payoutErr.message };
    }

    // H2, phase C: settle atomically — mark the rows, or refund the debit.
    try {
      const sclient = await pool.connect();
      try {
        await sclient.query('BEGIN');
        if (payoutResult.success) {
          await sclient.query(
            "UPDATE coin_withdrawals SET status = 'completed', tx_hash = $1 WHERE id = $2",
            [payoutResult.txHash || null, withdrawalId]
          );
          await sclient.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [ledgerId]);
        } else {
          await sclient.query(
            `UPDATE user_coin_balances
                SET available = available + $1, total_spent = total_spent - $1
              WHERE user_id = $2 AND coin = 'USD'`,
            [totalDeduction, userId]
          );
          await sclient.query("UPDATE coin_withdrawals SET status = 'failed' WHERE id = $1", [withdrawalId]);
          await sclient.query("UPDATE transactions SET status = 'refunded', description = $1 WHERE id = $2",
            [`${desc} — refunded (payout failed)`, ledgerId]);
        }
        await sclient.query('COMMIT');
      } catch (settleErr) {
        await sclient.query('ROLLBACK').catch(() => {});
        throw settleErr;
      } finally {
        sclient.release();
      }
    } catch (settleErr) {
      if (payoutResult.success) {
        // Payout went out but bookkeeping failed: DO NOT auto-refund (that
        // would double-pay) — surface for manual reconciliation instead.
        logger.error({ err: settleErr, withdrawalId, ledgerId }, 'CRITICAL: payout sent but settlement failed — manual reconciliation required');
        return res.status(500).json({ error: 'Payout sent but bookkeeping failed — contact support with your timestamp' });
      }
      // Refund-on-throw: the debit already committed, so the refund MUST land
      // even though settlement itself failed.
      logger.error({ err: settleErr, withdrawalId }, 'Withdrawal settlement failed — refunding debit');
      await pool.query(
        `UPDATE user_coin_balances
            SET available = available + $1, total_spent = total_spent - $1
          WHERE user_id = $2 AND coin = 'USD'`,
        [totalDeduction, userId]
      ).catch((refundErr) => logger.error({ err: refundErr, userId, totalDeduction }, 'REFUND FAILED — manual intervention required'));
      await pool.query("UPDATE coin_withdrawals SET status = 'failed' WHERE id = $1", [withdrawalId]).catch(() => {});
      await pool.query("UPDATE transactions SET status = 'refunded' WHERE id = $1", [ledgerId]).catch(() => {});
      return res.status(500).json({ error: 'Payout failed — you have been refunded' });
    }

    invalidateCache('/api/payments/balance');

    if (!payoutResult.success) {
      // Never forward provider error bodies to the client — log full detail,
      // return a generic message (refund already settled above).
      logger.error({ withdrawalId, err: payoutResult.error }, 'Payout failed — refunded');
      return res.status(500).json({
        error: 'Payout failed — you have been refunded',
      });
    }

    res.json({
      success: true,
      withdrawal: {
        coin: 'USDT',
        network: 'TRC-20',
        amount,
        fee,
        totalDeduction,
        toAddress,
        txHash: payoutResult.txHash,
      }
    });

  } catch (err) {
    logger.error({ err }, 'Request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/payments/history — USD transactions
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    // Whitelist the limit: raw query values go straight into LIMIT $2.
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const deposits = await pool.query(
      "SELECT * FROM coin_deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit]
    );
    const withdrawals = await pool.query(
      "SELECT * FROM coin_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit]
    );

    res.json({
      success: true,
      currency: 'USD',
      deposits: deposits.rows,
      withdrawals: withdrawals.rows,
    });

  } catch (err) {
    logger.error({ err }, 'Request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
