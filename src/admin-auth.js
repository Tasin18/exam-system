'use strict';

const crypto = require('node:crypto');
const { q } = require('./db');

/**
 * The dashboard sits on the same LAN as the students taking the exam, so it is
 * password-gated.
 *
 * ADMIN_PASSWORD wins if set. Otherwise one is generated ONCE and persisted, so
 * restarting the server mid-exam does not silently change the invigilator's
 * password. It is reprinted at every boot.
 */
function resolvePassword() {
  if (process.env.ADMIN_PASSWORD) {
    return { password: process.env.ADMIN_PASSWORD, source: 'env' };
  }

  const stored = q.getSetting.get('admin_password');
  if (stored && stored.value) {
    return { password: stored.value, source: 'stored' };
  }

  // Hex only, so there are no 0/O or 1/I lookalikes to misread off a screen.
  const generated = crypto.randomBytes(4).toString('hex').toUpperCase();
  q.setSetting.run('admin_password', generated);
  return { password: generated, source: 'generated' };
}

const resolved = resolvePassword();
const PASSWORD = resolved.password;
const SOURCE = resolved.source;
const GENERATED = SOURCE !== 'env';

/** Replaces the stored password. Used by `npm run password`. */
function setStoredPassword(next) {
  const value = String(next || '').trim();
  if (value.length < 4) throw new Error('Password must be at least 4 characters.');
  q.setSetting.run('admin_password', value);
  return value;
}

const tokens = new Map(); // token -> expiry ms
const TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issue(password) {
  if (!safeEqual(password, PASSWORD)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TTL_MS);
  return token;
}

function verify(token) {
  if (!token) return false;
  const expiry = tokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    tokens.delete(token);
    return false;
  }
  return true;
}

function tokenFrom(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return req.get('x-admin-token') || (req.query && req.query.adminToken) || null;
}

/** Express middleware guarding every /api/admin route. */
function requireAdmin(req, res, next) {
  if (verify(tokenFrom(req))) return next();
  return res.status(401).json({ error: 'Administrator authentication required.' });
}

module.exports = {
  PASSWORD, GENERATED, SOURCE, issue, verify, requireAdmin, tokenFrom, setStoredPassword,
};
