const { body, param, query, validationResult } = require('express-validator');

// Handle validation errors
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(e => ({ field: e.path, message: e.msg }))
    });
  }
  next();
}

// Auth validators
const registerRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('password').matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter'),
  body('password').matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter'),
  body('password').matches(/[0-9]/).withMessage('Password must contain at least one number'),
  // Role is never client-controlled: self-registration can only ever be 'user'.
  body('role').optional({ values: 'falsy' }).isIn(['user', 'worker']).withMessage('Invalid role'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
];

const googleAuthRules = [
  body('credential').notEmpty().withMessage('Google credential required'),
];

// Chat validators
// One optional attachment per message: { type, name, mime, data } where
// data is raw base64 (no data: prefix). Sizes are capped here and again in
// prepareAttachment before anything touches a model or the database.
const ATTACHMENT_MAX_B64 = 4000000; // ~3 MB decoded
const chatRules = [
  // A message may be empty ONLY when it carries an attachment (image-only /
  // voice-only sends); trim runs first so whitespace-only counts as empty.
  body('message').trim().custom((value, { req }) => {
    const msg = typeof value === 'string' ? value : '';
    if (msg.length > 10000) throw new Error('Message too long (max 10000 chars)');
    if (msg.length === 0 && !(req.body && req.body.attachment)) {
      throw new Error('Message required (max 10000 chars)');
    }
    return true;
  }),
  body('model').optional().isLength({ max: 100 }).withMessage('Model name too long'),
  body('attachment').optional({ values: 'null' }).custom((value) => {
    if (value === undefined || value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Attachment must be an object');
    if (!['image', 'file', 'audio'].includes(value.type)) throw new Error('Attachment type must be image, file or audio');
    if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255)) {
      throw new Error('Attachment name too long (max 255)');
    }
    if (value.mime !== undefined && (typeof value.mime !== 'string' || value.mime.length > 100)) {
      throw new Error('Attachment mime too long (max 100)');
    }
    if (typeof value.data !== 'string' || value.data.length === 0) throw new Error('Attachment data required (base64)');
    if (value.data.length > ATTACHMENT_MAX_B64) throw new Error('Attachment too large (max ~3MB)');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('Attachment data must be base64');
    return true;
  }),
];

// Worker validators
const workerRegisterRules = [
  body('wallet_address').isLength({ min: 42, max: 42 }).withMessage('Valid wallet address required'),
  body('gpu_model').optional().isLength({ max: 100 }),
  body('ram').optional().isLength({ max: 50 }),
  body('cpu').optional().isLength({ max: 100 }),
];

const heartbeatRules = [
  body('status').isIn(['online', 'offline', 'busy']).withMessage('Invalid status'),
  body('gpu_usage').optional().isFloat({ min: 0, max: 100 }),
  body('ram_usage').optional().isFloat({ min: 0, max: 100 }),
];

// Payment validators
const depositRules = [
  body('amount').isFloat({ min: 0.00000001 }).withMessage('Amount must be positive'),
  body('tx_hash').optional().isLength({ max: 66 }),
];

const transferRules = [
  body('to_user_id').isInt({ min: 1 }).withMessage('Valid recipient required'),
  body('amount').isFloat({ min: 0.00000001 }).withMessage('Amount must be positive'),
];

const stakeRules = [
  body('amount').isFloat({ min: 0.00000001 }).withMessage('Amount must be positive'),
];

module.exports = {
  validate,
  registerRules,
  loginRules,
  googleAuthRules,
  chatRules,
  workerRegisterRules,
  heartbeatRules,
  depositRules,
  transferRules,
  stakeRules,
};
