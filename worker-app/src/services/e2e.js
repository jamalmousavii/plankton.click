const crypto = require('crypto');

const SALT = Buffer.from('plankton-e2e-v1');
// Wire-protocol constant: tokens issued before the 1.0.0 relaunch (kz_) were
// paired with this salt by binaries already installed in the field, so they
// must keep deriving the same key or every task would fail to decrypt.
const LEGACY_SALT = Buffer.from('krelz-e2e-v1');
const INFO = Buffer.from('task-payload');

// Both sides derive the same key from the shared worker_token.
function deriveKey(token) {
  const salt = String(token).startsWith('kz_') ? LEGACY_SALT : SALT;
  return Buffer.from(crypto.hkdfSync('sha256', String(token), salt, INFO, 32));
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(key, obj) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(obj.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(obj.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(obj.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function isEncrypted(x) {
  return !!x && typeof x === 'object' &&
    typeof x.iv === 'string' && typeof x.tag === 'string' && typeof x.data === 'string';
}

module.exports = { deriveKey, encrypt, decrypt, isEncrypted };
