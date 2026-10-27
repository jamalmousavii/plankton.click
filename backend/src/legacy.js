// Pre-1.0 (Krelz-era) worker binaries and uninstall scripts already deployed
// in the field still speak the old wire names. These are protocol constants,
// not branding: accept them on input so those installs keep working until
// they are reinstalled with the 1.0.0 scripts.
const LEGACY_TOKEN_FIELD = 'miner_token';
const LEGACY_ID_FIELD = 'miner_id';

function legacyToken(body) {
  return body.worker_token || body[LEGACY_TOKEN_FIELD];
}

module.exports = { LEGACY_TOKEN_FIELD, LEGACY_ID_FIELD, legacyToken };
