// Daily free chat allowance (v3.27.0).
//
// Every subject — a signed-in user (daily_tokens, keyed by user_id) or a
// guest (daily_tokens_guest, keyed by client IP) — gets a per-UTC-day token
// allowance. Spending it is platform-funded: no wallet debit and no worker
// revenue share, exactly like the worker credit.
const pool = require('../database/pool');
const { FREE_DAILY_TOKENS } = require('./plans');

// All dates are compared on the UTC calendar so the daily reset does not
// depend on the DB or Node timezone (same contract as workerCredit.js).
const UTC_TODAY = `(now() AT TIME ZONE 'utc')::date`;

// Token counts are integers in practice, but DECIMAL storage + float JS
// arithmetic can drift; this keeps drift from denying a covered charge.
const TOKEN_EPSILON = 1e-6;

// Whitelisted identifiers only — never built from user input.
function subject(userId, guestKey) {
  if (userId) return { table: 'daily_tokens', col: 'user_id', val: userId };
  if (guestKey) {
    return { table: 'daily_tokens_guest', col: 'guest_key', val: String(guestKey).slice(0, 128) };
  }
  // No subject to track: report a full allowance (availability first — never
  // wall a request we cannot account for) and make charges no-ops.
  return null;
}

// Read-only snapshot for pre-flight checks and balance endpoints. A stale
// row (from a previous UTC day) counts as fully unused without writing.
async function getFreeStatus({ userId, guestKey, cap = FREE_DAILY_TOKENS, client = pool }) {
  const s = subject(userId, guestKey);
  if (!s) return { limit: cap, used: 0, remaining: cap };

  const r = await client.query(
    `SELECT CASE WHEN last_reset_date = ${UTC_TODAY}
                 THEN tokens_used_today
                 ELSE 0 END AS used
       FROM ${s.table}
      WHERE ${s.col} = $1`,
    [s.val]
  );
  const used = parseFloat(r.rows[0]?.used || 0);
  return { limit: cap, used, remaining: Math.max(0, cap - used) };
}

// Charge `tokens` against the daily allowance inside the caller's payment
// transaction. The upsert row-locks the row and rolls a stale (pre-UTC-today)
// usage to zero in the same statement, so parallel requests can't overspend.
// Returns { charged: boolean, remaining: number }.
async function chargeFreeTokens({ userId, guestKey, tokens, cap = FREE_DAILY_TOKENS, client = pool }) {
  const s = subject(userId, guestKey);
  if (!s) return { charged: true, remaining: cap };

  const r = await client.query(
    `INSERT INTO ${s.table} (${s.col}, tokens_used_today, last_reset_date)
          VALUES ($1, 0, ${UTC_TODAY})
     ON CONFLICT (${s.col}) DO UPDATE
        SET tokens_used_today = CASE
              WHEN ${s.table}.last_reset_date = ${UTC_TODAY} THEN ${s.table}.tokens_used_today
              ELSE 0
            END,
            last_reset_date = ${UTC_TODAY}
     RETURNING tokens_used_today`,
    [s.val]
  );

  const used = parseFloat(r.rows[0]?.tokens_used_today || 0);
  const remaining = Math.max(0, cap - used);
  if (remaining >= tokens - TOKEN_EPSILON) {
    await client.query(
      `UPDATE ${s.table} SET tokens_used_today = tokens_used_today + $1 WHERE ${s.col} = $2`,
      [tokens, s.val]
    );
    return { charged: true, remaining: Math.max(0, remaining - tokens) };
  }
  return { charged: false, remaining };
}

module.exports = { getFreeStatus, chargeFreeTokens };
