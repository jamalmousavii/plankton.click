const { Pool, types } = require('pg');
const { logger } = require('../logger');

// Parse numeric/decimal as float instead of string
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

// DATE (1082) stays a 'YYYY-MM-DD' string instead of pg's default local-midnight
// Date, so date columns always compare cleanly against the strings we store.
types.setTypeParser(1082, (val) => (val === null ? null : val));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  // Local-dev fallback only. Production must set DATABASE_URL explicitly.
  logger.warn('DATABASE_URL not set — falling back to local development defaults');
}

const pool = new Pool({
  connectionString: connectionString || 'postgresql://plankton:local_dev_only@localhost:5432/plankton',
  // B7: without bounds a hung statement parked every waiter — including
  // GET /health, so the LB never saw the box was stuck. These cap queueing,
  // connect attempts and single-statement runtime.
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '15000', 10),
});

pool.on('connect', () => {
  logger.debug('PostgreSQL connection established');
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error');
});

module.exports = pool;
