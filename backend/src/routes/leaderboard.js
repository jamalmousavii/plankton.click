const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../logger');

// GET /api/leaderboard/mine — own rank among workers (authenticated)
router.get('/mine', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `WITH ranked AS (
         SELECT m.user_id, m.id, m.gpu_model, m.wallet_address, m.current_model,
                m.total_tasks, m.earnings,
                RANK() OVER (ORDER BY m.earnings DESC) AS rank,
                COUNT(*) OVER () AS total
         FROM workers m
         WHERE m.total_tasks > 0
       )
       SELECT rank, total, id, gpu_model, wallet_address, current_model, total_tasks, earnings
       FROM ranked
       WHERE user_id = $1
       ORDER BY rank ASC
       LIMIT 1`,
      [req.user.id]
    );

    const row = result.rows[0] || null;

    // 5-way earnings breakdown (v3.28.0): which source paid and which plan
    // the payer was on. Historical rows backfilled as wallet/free.
    const breakdown = { tokens: 0, wallet: 0, plus: 0, pro: 0, max: 0 };
    if (row) {
      const bd = await pool.query(
        `SELECT source, plan_type, COALESCE(SUM(amount), 0) AS amount
           FROM worker_coin_earnings
          WHERE worker_id = $1 AND coin = 'USD'
          GROUP BY source, plan_type`,
        [row.id]
      );
      for (const r of bd.rows) {
        const amount = parseFloat(r.amount) || 0;
        if (r.source === 'tokens') {
          breakdown.tokens += amount;
        } else {
          // Plus/Pro/Max = subscription revenue shared per token (source 'plan');
          // wallet = pay-as-you-go, whatever tier the payer happened to be on.
          const key = r.source === 'plan' && ['plus', 'pro', 'max'].includes(r.plan_type) ? r.plan_type : 'wallet';
          breakdown[key] += amount;
        }
      }
    }

    if (!row) {
      const any = await pool.query(
        `SELECT COUNT(*)::int AS n FROM workers
         WHERE user_id = $1 AND (status IS NULL OR status != 'removed')`,
        [req.user.id]
      );
      if (Number(any.rows[0].n) === 0) {
        return res.json({ success: true, isWorker: false, rank: null });
      }
      const total = await pool.query(
        `SELECT COUNT(*)::int AS n FROM workers WHERE total_tasks > 0`
      );
      return res.json({
        success: true, isWorker: true, rank: null,
        total: Number(total.rows[0].n), worker: null
      });
    }

    res.json({
      success: true,
      isWorker: true,
      rank: Number(row.rank),
      total: Number(row.total),
      breakdown,
      worker: {
        id: row.id,
        gpu_model: row.gpu_model,
        wallet_address: row.wallet_address,
        current_model: row.current_model,
        total_tasks: row.total_tasks,
        earnings: row.earnings
      }
    });
  } catch (err) {
    logger.error({ err }, 'Leaderboard mine route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// The public /workers and /users lists were removed in favour of the admin
// panel (workers sorted by earnings, users sortable by usage/spend): they
// exposed every worker's earnings and had nothing useful for regular users.

module.exports = router;
