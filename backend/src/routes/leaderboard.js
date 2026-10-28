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

// GET /api/leaderboard/workers
router.get('/workers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, wallet_address, gpu_model, total_tasks, earnings, status, current_model
       FROM workers
       WHERE total_tasks > 0
       ORDER BY earnings DESC
       LIMIT 50`
    );
    res.json({ success: true, workers: result.rows });
  } catch (err) {
    logger.error({ err }, 'Leaderboard route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/leaderboard/users
router.get('/users', async (req, res) => {
  try {
    // B10: earnings live in user_coin_balances (all money flows write there);
    // the legacy user_balances.total_earned column nobody updates made the
    // users leaderboard permanently empty.
    const result = await pool.query(
      `SELECT u.id, u.name, u.avatar, COALESCE(c.total_earned, 0) as earned, COALESCE(c.total_spent, 0) as spent
       FROM users u
       LEFT JOIN user_coin_balances c ON u.id = c.user_id AND c.coin = 'USD'
       WHERE COALESCE(c.total_earned, 0) > 0
       ORDER BY c.total_earned DESC
       LIMIT 50`
    );
    res.json({ success: true, users: result.rows });
  } catch (err) {
    logger.error({ err }, 'Leaderboard route failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
