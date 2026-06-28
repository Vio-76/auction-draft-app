/**
 * Authentication. Captains authenticate with their name + per-captain code (the only gate
 * on the public captain page, as before). Admin auth is a single shared password, checked
 * against a hash derived from ADMIN_PASSWORD, with a signed session cookie.
 */

const crypto = require('node:crypto');
const { captainByName } = require('./state');

// ----- captain auth (ported from SheetReaders.js checkCode) -----

function checkCode(name, code) {
  if (!name || !code) return false;
  const c = captainByName(name);
  return !!c && String(c.code).trim() === String(code).trim();
}

// ----- admin auth -----

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkAdminPassword(password) {
  return timingSafeEqualStr(password || '', ADMIN_PASSWORD);
}

/** A session token = HMAC(SESSION_SECRET, "admin"); opaque and verifiable, no storage. */
function makeAdminToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('admin').digest('hex');
}

function isValidAdminToken(token) {
  if (!token) return false;
  return timingSafeEqualStr(token, makeAdminToken());
}

module.exports = { checkCode, checkAdminPassword, makeAdminToken, isValidAdminToken };
