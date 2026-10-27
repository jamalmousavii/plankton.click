const jwt = require('jsonwebtoken');
const pool = require('../database/pool');
const { logger } = require('../logger');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  logger.warn('JWT_SECRET is shorter than 32 characters — use a long random secret in production');
}

const JWT_OPTIONS = { algorithms: ['HS256'] };

// H3: token_version — bumped on password mutations (set/change/reset), so every
// JWT minted before the change stops verifying. The same short-lived per-user
// cache also carries `banned` (v3.39.0), so one indexed read per 10s enforces
// both session freshness and account bans.
const authStateCache = new Map(); // userId -> { version, banned, expiresAt }
const TOKEN_VERSION_CACHE_MS = 10 * 1000;

async function currentAuthState(userId) {
  if (!userId) return null;
  const cached = authStateCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { version: cached.version, banned: cached.banned };
  }
  try {
    const result = await pool.query('SELECT token_version, banned FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const state = { version: Number(row.token_version) || 0, banned: Boolean(row.banned) };
    authStateCache.set(userId, { ...state, expiresAt: Date.now() + TOKEN_VERSION_CACHE_MS });
    return state;
  } catch (err) {
    // Fail OPEN on lookup errors: with Postgres down every real endpoint is
    // already dead, and a transient blip must not mass-logout every user.
    // (auth.security.test.js runs with no DB — this path keeps it green.)
    logger.warn({ err }, 'auth state lookup failed — allowing request');
    return null; // null = unverified → caller allows
  }
}

function invalidateTokenVersion(userId) {
  authStateCache.delete(userId);
}

async function tokenVersionMatches(decoded) {
  const want = Number(decoded.token_version) || 0; // pre-H3 tokens = 0
  const state = await currentAuthState(decoded.id);
  if (state === null) return true; // unverified → allow
  return !state.banned && state.version === want;
}

// Verify JWT token
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, JWT_OPTIONS);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
  const state = await currentAuthState(decoded.id);
  if (state !== null) {
    if (state.version !== (Number(decoded.token_version) || 0)) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (state.banned) {
      return res.status(403).json({ error: 'Account banned.' });
    }
  }
  req.user = decoded;
  // Outside the try: an exception thrown further down the chain must reach
  // the error handler, not be misreported as an invalid token (401).
  next();
}

// Optional auth (doesn't fail if no token)
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET, JWT_OPTIONS);
      // A stale (post-password-change) token degrades to anonymous instead of
      // authenticating — same rule as authenticate, softer consequence.
      if (await tokenVersionMatches(decoded)) {
        req.user = decoded;
      }
    } catch (err) { /* treat as anonymous */ }
  }
  next();
}

// F4: public-by-default, but a PRESENT Authorization header must be valid —
// a garbage/expired bearer gets 401 (→ client clean-logout) instead of
// silently downgrading a signed-in chat to an anonymous guest answer.
async function strictIfHeader(req, res, next) {
  if (!req.headers.authorization) return next(); // genuinely anonymous
  return authenticate(req, res, next);
}

// Require admin role.
// The role claim inside the JWT can be stale (or, historically, self-assigned),
// so admin privileges are re-checked against the database with a short cache.
const adminRoleCache = new Map(); // userId -> { isAdmin, expiresAt }
const ADMIN_CACHE_MS = 60 * 1000;

async function isAdmin(userId) {
  if (!userId) return false;
  const cached = adminRoleCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.isAdmin;

  let isAdminUser = false;
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    isAdminUser = result.rows.length > 0 && result.rows[0].role === 'admin';
  } catch (err) {
    logger.error({ err }, 'requireAdmin role lookup failed');
    return false; // fail closed
  }

  adminRoleCache.set(userId, { isAdmin: isAdminUser, expiresAt: Date.now() + ADMIN_CACHE_MS });
  return isAdminUser;
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  isAdmin(req.user.id)
    .then((ok) => {
      if (!ok) return res.status(403).json({ error: 'Admin access required.' });
      next();
    })
    .catch(() => res.status(500).json({ error: 'Server error' }));
}

module.exports = { authenticate, optionalAuth, strictIfHeader, requireAdmin, invalidateTokenVersion };
