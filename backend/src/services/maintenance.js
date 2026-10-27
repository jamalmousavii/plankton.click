const pool = require('../database/pool');
const nowpayments = require('./nowpayments');
const { applyPlanPurchase, applyDeposit } = require('./paymentClaims');
const { settleMessage } = require('./billing');
const { resolveCap } = require('./org');
const { logger } = require('../logger');

const RECONCILE_BATCH = 25;
const RECONCILE_MINUTES = 30;
const MEDIA_RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS || '7', 10);
// Billing reconciliation (v3.45.0): a task served but left unsettled (the
// chat/v1 route marked it when settleMessage threw). settleMessage is ONE
// rolled-back transaction, so a retry can never double-charge; after
// BILLING_RETRY_MAX failed attempts the row parks as 'unreconciled' for ops.
const BILLING_RETRY_MAX = 3;
const BILLING_RETRY_MINUTES = 5;

// B4: IPN delivery is not guaranteed (NowPayments outage, webhook 5xx,
// nginx restart mid-flight). Re-check stale pending purchases against the
// NowPayments API and apply them through the SAME exactly-once claim helpers
// the webhook uses — a late IPN racing the reconciler still credits once.
// Only 'finished' invoices are applied; expired rows are left pending (an
// expired invoice can never reach 'finished', and marking failed rows risks
// breaking a live invoice whose invoice_id we failed to store).
async function reconcilePendingPayments() {
  const stalePurchases = await pool.query(
    `SELECT order_id, user_id, invoice_id
       FROM plan_purchases
      WHERE status = 'pending'
        AND invoice_id IS NOT NULL
        AND created_at < NOW() - make_interval(mins => $1)
      ORDER BY created_at ASC
      LIMIT $2`,
    [RECONCILE_MINUTES, RECONCILE_BATCH]
  );

  for (const row of stalePurchases.rows) {
    try {
      const invoice = await nowpayments.getPaymentStatus(row.invoice_id);
      if (!invoice.success || invoice.status?.payment_status !== 'finished') continue;
      const outcome = await applyPlanPurchase({ userId: row.user_id, orderId: row.order_id });
      logger.info({ orderId: row.order_id, deduped: outcome.deduped }, 'Reconciled plan purchase');
    } catch (err) {
      logger.error({ err, orderId: row.order_id }, 'Plan purchase reconciliation failed');
    }
  }

  const staleDeposits = await pool.query(
    `SELECT order_id, user_id, processor_id
       FROM coin_deposits
      WHERE status = 'pending'
        AND created_at < NOW() - make_interval(mins => $1)
      ORDER BY created_at ASC
      LIMIT $2`,
    [RECONCILE_MINUTES, RECONCILE_BATCH]
  );

  for (const row of staleDeposits.rows) {
    try {
      const invoice = await nowpayments.getPaymentStatus(row.processor_id);
      if (!invoice.success || invoice.status?.payment_status !== 'finished') continue;
      const outcome = await applyDeposit({
        userId: row.user_id,
        orderId: row.order_id,
        invoiceId: row.processor_id,
      });
      logger.info({ orderId: row.order_id, deduped: outcome.deduped }, 'Reconciled deposit');
    } catch (err) {
      logger.error({ err, orderId: row.order_id }, 'Deposit reconciliation failed');
    }
  }
}

// B11: tasks.media holds base64 payloads that were never pruned — every
// GET /sessions/:id re-selects them, so one old screenshot inflates every
// future session fetch (and the table) forever. Strip media past the
// retention window; messages keep their text.
async function pruneOldMedia() {
  const result = await pool.query(
    `UPDATE tasks
        SET media = NULL
      WHERE media IS NOT NULL
        AND created_at < NOW() - make_interval(days => $1)`,
    [MEDIA_RETENTION_DAYS]
  );
  if (result.rowCount > 0) {
    logger.info({ count: result.rowCount, days: MEDIA_RETENTION_DAYS }, 'Pruned old task media');
  }
}

// v3.45.0: retry settlement for tasks the routes marked billing_pending.
// Nothing was charged on the failed attempt (single rolled-back transaction),
// so re-running settleMessage with the stored tokens/cost is safe. The cap
// is recomputed at retry time (resolveCap) — a rare, bounded drift.
async function reconcileBilling() {
  const rows = await pool.query(
    `SELECT id, user_id, worker_id, tokens_used, cost
       FROM tasks
      WHERE billing_status = 'pending'
        AND status = 'completed'
        AND billing_attempts < $1
        AND completed_at < NOW() - make_interval(mins => $2)
      ORDER BY id ASC
      LIMIT $3`,
    [BILLING_RETRY_MAX, BILLING_RETRY_MINUTES, RECONCILE_BATCH]
  );

  for (const t of rows.rows) {
    try {
      const resolved = await resolveCap(t.user_id, null);
      await settleMessage({
        userId: t.user_id,
        guestKey: null,
        tokensUsed: Number(t.tokens_used) || 0,
        cost: Number(t.cost) || 0,
        workerId: t.worker_id,
        servedByWorker: !!t.worker_id,
        freeCap: resolved.cap,
        freeRemainingInit: null,
        bucketUserId: resolved.bucketUserId,
        paymentCoin: 'USD',
        taskId: t.id,
      });
      await pool.query("UPDATE tasks SET billing_status = 'settled' WHERE id = $1", [t.id]);
      logger.info({ taskId: t.id }, 'Reconciled billing_pending task');
    } catch (err) {
      await pool
        .query(
          `UPDATE tasks
              SET billing_attempts = billing_attempts + 1,
                  billing_status = CASE WHEN billing_attempts + 1 >= $2 THEN 'unreconciled' ELSE 'pending' END
            WHERE id = $1`,
          [t.id, BILLING_RETRY_MAX]
        )
        .catch((e) => logger.error({ err: e, taskId: t.id }, 'Failed to bump billing attempts'));
      logger.error({ err, taskId: t.id }, 'Billing reconciliation attempt failed');
    }
  }
}

// Idempotent by construction: claims are exactly-once and NULL-ing old media
// is safe to repeat, so restarts/overlapping runs are harmless.
async function runMaintenance() {
  try {
    await reconcilePendingPayments();
  } catch (err) {
    logger.error({ err }, 'Payment reconciliation run failed');
  }
  try {
    await pruneOldMedia();
  } catch (err) {
    logger.error({ err }, 'Media prune run failed');
  }
  try {
    await reconcileBilling();
  } catch (err) {
    logger.error({ err }, 'Billing reconciliation run failed');
  }
}

module.exports = { runMaintenance, reconcilePendingPayments, pruneOldMedia, reconcileBilling };
