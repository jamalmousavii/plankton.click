const pool = require('./pool');

// Run `fn(client)` inside a transaction; on failure roll back and rethrow.
// Shared by routes/admin.js and routes/teams.js (v3.45.0) — previously a
// local helper in admin.js only, while multi-statement org mutations ran
// unbatched (leave/transfer could half-apply on a crash).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
