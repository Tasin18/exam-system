'use strict';

/**
 * Per-client request limiting.
 *
 * On a LAN this was unnecessary: the only people who could reach the login
 * endpoints were already in the room. Published to the internet, `/api/admin/login`
 * is a password oracle anyone can hammer, and `/api/auth/login` is a way to burn
 * through student IDs to find one that has not sat the exam yet.
 *
 * In-memory on purpose. The whole system is a single process holding one SQLite
 * file — presence, admin tokens and the exam clock already live in this process,
 * so there is nothing to gain from an external store and a lot of operational
 * weight to lose.
 *
 * Two separate mechanisms, because they answer different questions:
 *
 *  - `limiter()` caps how *often* anyone may call an endpoint.
 *  - `lockout()` caps how many times they may call it *wrongly*, which is what
 *    actually stops password guessing — a correct login never counts against it.
 */

/** Real client address, honouring `trust proxy` (Express has already vetted it). */
function clientKey(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Fixed-window counter. Cheap, and precise enough to stop a script. */
function createLimiter({ windowMs, max, message }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Windows expire on their own; this only stops the map growing without bound
  // when many distinct addresses each make one request.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, Math.max(windowMs, 30_000));
  sweep.unref?.();

  return function limit(req, res, next) {
    const key = clientKey(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

/**
 * Failure-triggered lockout.
 *
 * Returns a guard middleware plus `fail()` / `succeed()` for the route to call
 * once it knows whether the credential was right. Keeping the decision in the
 * route means a legitimate invigilator logging in repeatedly — reopening the
 * dashboard on a second device, say — never locks themselves out.
 */
function createLockout({ windowMs, maxFailures, blockMs, message }) {
  const state = new Map(); // key -> { failures, firstAt, blockedUntil }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of state) {
      const stale = (entry.blockedUntil || 0) <= now && now - entry.firstAt > windowMs;
      if (stale) state.delete(key);
    }
  }, Math.max(blockMs, 60_000));
  sweep.unref?.();

  const guard = (req, res, next) => {
    const entry = state.get(clientKey(req));
    if (!entry || !entry.blockedUntil || entry.blockedUntil <= Date.now()) return next();
    const seconds = Math.ceil((entry.blockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', String(seconds));
    return res.status(429).json({
      error: `${message || 'Too many failed attempts.'} Try again in ${seconds} seconds.`,
    });
  };

  guard.fail = (req) => {
    const key = clientKey(req);
    const now = Date.now();
    let entry = state.get(key);
    if (!entry || now - entry.firstAt > windowMs) {
      entry = { failures: 0, firstAt: now, blockedUntil: 0 };
      state.set(key, entry);
    }
    entry.failures += 1;
    if (entry.failures >= maxFailures) {
      entry.blockedUntil = now + blockMs;
      entry.failures = 0;
      entry.firstAt = now;
    }
  };

  guard.succeed = (req) => { state.delete(clientKey(req)); };
  guard.reset = () => state.clear();

  return guard;
}

module.exports = { createLimiter, createLockout, clientKey };
