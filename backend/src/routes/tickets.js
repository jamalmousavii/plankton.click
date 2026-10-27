// Support tickets (v3.39.0) — user side. A ticket is a subject/category row
// plus a thread in ticket_messages; the first user message is created in the
// same transaction as the ticket so an "empty" ticket can never exist.
// Status flow: open (waiting on admin) → answered (admin replied) → back to
// open on a user reply → closed (either side). Only the owner sees a ticket.
const express = require('express');
const router = express.Router();
const pool = require('../database/pool');
const { authenticate } = require('../middleware/auth');
const { logger } = require('../logger');

const CATEGORIES = ['support', 'billing', 'worker'];
const MAX_SUBJECT = 200;
const MAX_BODY = 4000;
const MAX_LIST = 50;

// POST /api/tickets — create ticket + first message (one transaction)
router.post('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const subject = String(req.body.subject || '').trim();
    const body = String(req.body.body || '').trim();
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'support';
    if (!subject || subject.length > MAX_SUBJECT) {
      return res.status(400).json({ error: `Subject required (max ${MAX_SUBJECT} chars)` });
    }
    if (!body || body.length > MAX_BODY) {
      return res.status(400).json({ error: `Message required (max ${MAX_BODY} chars)` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ticket = await client.query(
        `INSERT INTO tickets (user_id, subject, category, status)
             VALUES ($1, $2, $3, 'open') RETURNING *`,
        [userId, subject, category]
      );
      await client.query(
        'INSERT INTO ticket_messages (ticket_id, user_id, is_admin, body) VALUES ($1, $2, false, $3)',
        [ticket.rows[0].id, userId, body]
      );
      await client.query('COMMIT');
      res.status(201).json({ success: true, ticket: ticket.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'Ticket create failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tickets — my tickets with a last-message preview
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*,
              (SELECT m.body FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
         FROM tickets t
        WHERE t.user_id = $1
        ORDER BY t.updated_at DESC, t.id DESC
        LIMIT $2`,
      [req.user.id, MAX_LIST]
    );
    res.json({ success: true, tickets: result.rows });
  } catch (err) {
    logger.error({ err }, 'Ticket list failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tickets/:id — detail + full thread (owner only)
router.get('/:id', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Not found' });
    const ticket = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (ticket.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const messages = await pool.query(
      'SELECT id, user_id, is_admin, body, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id',
      [id]
    );
    res.json({ success: true, ticket: ticket.rows[0], messages: messages.rows });
  } catch (err) {
    logger.error({ err }, 'Ticket detail failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tickets/:id/messages — owner replies (closed → 409)
router.post('/:id/messages', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Not found' });
    const body = String(req.body.body || '').trim();
    if (!body || body.length > MAX_BODY) {
      return res.status(400).json({ error: `Message required (max ${MAX_BODY} chars)` });
    }

    const ticket = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (ticket.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (ticket.rows[0].status === 'closed') {
      return res.status(409).json({ error: 'Ticket is closed' });
    }

    const message = await pool.query(
      'INSERT INTO ticket_messages (ticket_id, user_id, is_admin, body) VALUES ($1, $2, false, $3) RETURNING *',
      [id, req.user.id, body]
    );
    // A user reply hands it back to the admin queue.
    const updated = await pool.query(
      `UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.status(201).json({ success: true, message: message.rows[0], ticket: updated.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Ticket reply failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tickets/:id/close — the owner can close their own ticket
router.post('/:id/close', authenticate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Not found' });
    const ticket = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticket.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (ticket.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const updated = await pool.query(
      `UPDATE tickets SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json({ success: true, ticket: updated.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Ticket close failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
