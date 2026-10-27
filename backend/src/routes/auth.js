const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../database/pool');
const { OAuth2Client } = require('google-auth-library');
const { validate, registerRules, loginRules, googleAuthRules } = require('../middleware/validate');
const { isEmailConfigured, sendPasswordResetEmail } = require('../services/email');
const { authenticate, invalidateTokenVersion } = require('../middleware/auth');
const { logger } = require('../logger');

if (!process.env.GOOGLE_CLIENT_ID) {
  logger.warn('GOOGLE_CLIENT_ID is not set — Google login will return 503 until configured');
}
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

// POST /api/auth/register
router.post('/register', registerRules, validate, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Defense-in-depth: validator already enforces this, but never create a
    // weak hash if validation is ever bypassed.
    if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase and number' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Never trust a client-supplied role: admin/worker roles are granted server-side only.
    // ON CONFLICT turns the previous SELECT-then-INSERT race into a clean 400.
    const result = await pool.query(
      `INSERT INTO users (email, password, role) VALUES ($1, $2, 'user')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, role, token_version`,
      [email, hashedPassword]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Create empty balance
    await pool.query(
      'INSERT INTO user_balances (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [result.rows[0].id]
    );

    const token = jwt.sign(
      { id: result.rows[0].id, email, role: result.rows[0].role, token_version: result.rows[0].token_version || 0 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Never expose token_version to the client — it is a server-side session nonce.
    const { token_version: _tv, password: _pw, ...safeUser } = result.rows[0];
    res.status(201).json({
      success: true,
      token,
      user: safeUser
    });

  } catch (err) {
    logger.error({ err }, 'Auth request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', loginRules, validate, async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.password) {
      return res.status(401).json({ error: 'This account uses Google Login. Please sign in with Google.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // v3.39.0: banned accounts cannot start a new session (enforced on every
    // request too, via the cached auth state in authenticate()).
    if (user.banned) {
      return res.status(403).json({ error: 'Account banned.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, token_version: user.token_version || 0 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });

  } catch (err) {
    logger.error({ err }, 'Auth request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/google
router.post('/google', googleAuthRules, validate, async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google login is not configured' });
    }
    const { credential } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // B8: email is this route's identity key (lookup + INSERT) — an unverified
    // Google email must never map onto (or create) an account here.
    if (!payload.email_verified || !email) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }

    const SAFE_COLS = 'id, email, name, avatar, role, token_version, banned';
    let userRow;
    const found = await pool.query(
      `SELECT ${SAFE_COLS} FROM users WHERE google_id = $1 OR email = $2`,
      [googleId, email]
    );

    if (found.rows.length > 0) {
      userRow = found.rows[0];
      // B8: update by PRIMARY KEY — the old `WHERE email` re-keyed the row you
      // had just resolved via google_id (and raced with email changes).
      const updated = await pool.query(
        `UPDATE users
            SET google_id = COALESCE(google_id, $1),
                name = COALESCE(name, $2),
                avatar = COALESCE(avatar, $3),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $4
          RETURNING ${SAFE_COLS}`,
        [googleId, name, picture, userRow.id]
      );
      userRow = updated.rows[0] || userRow;
    } else {
      const inserted = await pool.query(
        `INSERT INTO users (email, name, avatar, google_id, role)
         VALUES ($1, $2, $3, $4, 'user')
         ON CONFLICT (email) DO NOTHING
         RETURNING ${SAFE_COLS}`,
        [email, name, picture, googleId]
      );
      if (inserted.rows.length > 0) {
        userRow = inserted.rows[0];
      } else {
        // Lost the create race — adopt the row another request just inserted.
        const race = await pool.query(
          `SELECT ${SAFE_COLS} FROM users WHERE email = $1 OR google_id = $2`,
          [email, googleId]
        );
        if (race.rows.length === 0) {
          return res.status(409).json({ error: 'Account conflict. Try again.' });
        }
        userRow = race.rows[0];
      }
      await pool.query(
        'INSERT INTO user_balances (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [userRow.id]
      );
    }

    const user = userRow;

    // Banned accounts cannot mint a new session via Google either (login already blocks).
    if (user.banned) {
      return res.status(403).json({ error: 'Account banned.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, token_version: user.token_version || 0 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { token_version: _gtv, banned: _banned, ...safeGoogleUser } = user;
    res.json({ success: true, token, user: safeGoogleUser });

  } catch (err) {
    logger.error({ err }, 'Google auth error');
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

// POST /api/auth/set-password — set password for Google users
// Uses authenticate so stale (post-rotation) and banned tokens are rejected
// before any mutation — manual jwt.verify alone bypassed token_version/banned.
router.post('/set-password', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const { password } = req.body;

    // Validate password: min 8 chars, uppercase, lowercase, number
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter' });
    }
    if (!/[a-z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one lowercase letter' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number' });
    }

    // Check if user already has a password
    const userResult = await pool.query('SELECT password, email, role, token_version FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (userResult.rows[0].password) {
      return res.status(400).json({ error: 'Password already set. Use change-password instead.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    // H3: setting a password clears any outstanding reset token and bumps
    // token_version, so every previously issued JWT (incl. this one) dies.
    await pool.query(
      `UPDATE users
          SET password = $1, reset_token = NULL, reset_token_expiry = NULL,
              token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [hashedPassword, userId]
    );
    invalidateTokenVersion(userId);

    // Fresh token for THIS caller: it carries the new version, so the acting
    // session survives while every other one 401s.
    const freshToken = jwt.sign(
      { id: userId, email: userResult.rows[0].email, role: userResult.rows[0].role, token_version: (Number(userResult.rows[0].token_version) || 0) + 1 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, message: 'Password set successfully', token: freshToken });

  } catch (err) {
    logger.error({ err }, 'Auth request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/change-password — change password for email users
// Uses authenticate so stale (post-rotation) and banned tokens are rejected
// before any mutation — manual jwt.verify alone bypassed token_version/banned.
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }

    // Validate new password
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(new_password)) {
      return res.status(400).json({ error: 'New password must contain at least one uppercase letter' });
    }
    if (!/[a-z]/.test(new_password)) {
      return res.status(400).json({ error: 'New password must contain at least one lowercase letter' });
    }
    if (!/[0-9]/.test(new_password)) {
      return res.status(400).json({ error: 'New password must contain at least one number' });
    }

    // Get current password hash
    const userResult = await pool.query('SELECT password, email, role, token_version FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!userResult.rows[0].password) {
      return res.status(400).json({ error: 'No password set. Use set-password instead.' });
    }

    // Verify current password
    const validPassword = await bcrypt.compare(current_password, userResult.rows[0].password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 12);
    // H3: password change = invalidate every other session (and any pending
    // reset link); the caller gets a fresh token below.
    await pool.query(
      `UPDATE users
          SET password = $1, reset_token = NULL, reset_token_expiry = NULL,
              token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [hashedPassword, userId]
    );
    invalidateTokenVersion(userId);

    const freshToken = jwt.sign(
      { id: userId, email: userResult.rows[0].email, role: userResult.rows[0].role, token_version: (Number(userResult.rows[0].token_version) || 0) + 1 },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, message: 'Password changed successfully', token: freshToken });

  } catch (err) {
    logger.error({ err }, 'Auth request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/forgot-password — send reset token
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const isDev = process.env.NODE_ENV === 'development';
    // Checked before any account lookup so the failure code cannot be used to
    // enumerate accounts: with no transport configured EVERY request gets 503.
    if (!isEmailConfigured() && !isDev) {
      return res.status(503).json({
        error: 'Password reset is temporarily unavailable. Please try again later.',
      });
    }

    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

    // Always return success to prevent email enumeration
    if (userResult.rows.length === 0) {
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }

    const userId = userResult.rows[0].id;
    const resetToken = crypto.randomBytes(32).toString('hex');
    // L1: store only sha256(token) — a DB leak must not yield account takeover.
    // Hex digest is 64 chars, same length as the raw token column.
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiry = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
      [resetTokenHash, expiry, userId]
    );

    // The token is delivered by email only. Returning it in the response body
    // (or logging it) would let anyone take over any account in two requests.
    if (isEmailConfigured()) {
      try {
        await sendPasswordResetEmail(email, resetToken);
      } catch (err) {
        logger.error({ err: err.message }, 'Password reset email failed');
        // fall through: respond generically so the endpoint stays enumeration-safe
      }
    } else {
      logger.warn('RESEND_API_KEY missing — password reset email was NOT sent');
      if (isDev) {
        // Dev-only escape hatch: surface the token locally when no SMTP/Resend is wired up.
        return res.json({
          success: true,
          message: 'If an account exists, a reset link has been sent.',
          reset_token: resetToken,
        });
      }
    }

    res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });

  } catch (err) {
    logger.error({ err }, 'Auth request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/reset-password — verify token + set password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    // Validate password
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter' });
    }
    if (!/[a-z]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one lowercase letter' });
    }
    if (!/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one number' });
    }

    // Find user with valid token — compare sha256 hash (see forgot-password).
    // Accepts legacy plaintext rows too (hash length 64 vs raw 64 collides, so
    // try hash first, then raw for rows written before this fix).
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    let userResult = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
      [tokenHash]
    );
    if (userResult.rows.length === 0) {
      userResult = await pool.query(
        'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
        [token]
      );
    }

    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const userId = userResult.rows[0].id;
    const hashedPassword = await bcrypt.hash(password, 12);

    // H3: an email-reset takeover must kill every existing session too.
    await pool.query(
      `UPDATE users
          SET password = $1, reset_token = NULL, reset_token_expiry = NULL,
              token_version = COALESCE(token_version, 0) + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [hashedPassword, userId]
    );
    invalidateTokenVersion(userId);

    res.json({ success: true, message: 'Password reset successfully' });

  } catch (err) {
    logger.error({ err }, 'Auth request failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
