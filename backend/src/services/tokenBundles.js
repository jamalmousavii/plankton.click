// Prepaid token pot: whole dollars in (TOKEN_BUNDLE.tokens_per_usd each),
// never expires. Settles between the daily free allowance and the USD wallet.
const pool = require('../database/pool');

async function getTokenBalance(userId, client = pool) {
  if (!userId) return 0;
  const r = await client.query(
    'SELECT tokens FROM user_token_balances WHERE user_id = $1',
    [userId]
  );
  return parseInt(r.rows[0]?.tokens || 0, 10);
}

// All-or-nothing deduct (mirrors chargeFreeTokens): the message's full token
// count must fit in the pot, otherwise the next leg of the chain takes over.
// The UPDATE re-checks the balance under the row lock, so parallel messages
// cannot overspend.
async function chargeTokenPot({ userId, tokens, client = pool }) {
  if (!userId || !(tokens >= 0)) return { charged: false, remaining: 0 };

  const deducted = await client.query(
    `UPDATE user_token_balances
        SET tokens = tokens - $2
      WHERE user_id = $1 AND tokens >= $2
      RETURNING tokens`,
    [userId, tokens]
  );
  if (deducted.rows.length > 0) {
    return { charged: true, remaining: parseInt(deducted.rows[0].tokens, 10) };
  }

  const r = await client.query(
    'SELECT COALESCE(tokens, 0) AS tokens FROM user_token_balances WHERE user_id = $1',
    [userId]
  );
  return { charged: false, remaining: parseInt(r.rows[0]?.tokens || 0, 10) };
}

// Credit after a confirmed `tok-…` invoice (claimed via plan_purchases
// before this runs), inside the caller's transaction.
async function creditTokens(userId, tokens, client = pool) {
  const amount = Math.max(0, Math.round(tokens));
  await client.query(
    `INSERT INTO user_token_balances (user_id, tokens, total_purchased)
          VALUES ($1, $2, $2)
     ON CONFLICT (user_id) DO UPDATE
        SET tokens = user_token_balances.tokens + $2,
            total_purchased = user_token_balances.total_purchased + $2,
            updated_at = now()`,
    [userId, amount]
  );
}

module.exports = { getTokenBalance, chargeTokenPot, creditTokens };
