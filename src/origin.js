'use strict';

const os = require('node:os');

/**
 * Where students should point their browser.
 *
 * This system began as a LAN-only tool: the join address was always this
 * machine's Wi-Fi IPv4 address. Serving the same app over the public internet
 * breaks that assumption in both directions —
 *
 *  - the machine's own address (10.x, a container's 172.17.x, a cloud host's
 *    private VPC address) is meaningless to anyone outside the network, and
 *  - the port the process listens on is rarely the port the world connects to,
 *    because a reverse proxy or the platform's load balancer terminates TLS on
 *    443 and forwards to whatever PORT it injected.
 *
 * So the join address is resolved from, in order:
 *
 *  1. `PUBLIC_URL` — set this when the app is reachable from the internet.
 *     It is the only source that is correct even when nothing is connected,
 *     which is what the boot banner and the terminal QR code need.
 *  2. The forwarded request headers, when `TRUST_PROXY` says a proxy is in
 *     front. Covers "I deployed it and forgot to set PUBLIC_URL".
 *  3. This machine's LAN address — the original behaviour, unchanged, so
 *     running it on a classroom laptop still works exactly as before.
 */

/** Adds a scheme, drops a trailing slash and any path. Returns null if unusable. */
function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // A bare host in an env var is the common mistake; assume TLS, not plaintext.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

const PUBLIC_URL = normalizeUrl(process.env.PUBLIC_URL);

/**
 * Whether this process is being served to the internet at large.
 *
 * Several defences key off this — the admin password stops being auto-generated,
 * HSTS turns on, the password is kept out of the logs — so it is deliberately
 * explicit rather than guessed from the environment.
 */
const INTERNET_MODE = !!PUBLIC_URL;

/**
 * Value for Express's `trust proxy`.
 *
 * Wrong either way is a real bug: unset behind a proxy makes every client look
 * like it is coming from the proxy, which collapses rate limiting into a single
 * bucket; set with no proxy in front lets a client spoof its own IP with an
 * `X-Forwarded-For` header. Defaults to trusting one hop when PUBLIC_URL is set,
 * because a public deployment essentially always has exactly one proxy.
 */
function trustProxySetting() {
  const raw = String(process.env.TRUST_PROXY || '').trim();
  if (!raw) return INTERNET_MODE ? 1 : false;
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // a subnet or comma-separated list, e.g. "loopback, 10.0.0.0/8"
}

/* ------------------------------------------------------------------ *
 * LAN address (the original behaviour)
 * ------------------------------------------------------------------ */

/** First non-internal IPv4 address — the one students type on a local network. */
function lanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push({ name, address: addr.address });
    }
  }
  // Prefer typical LAN ranges over virtual adapters (Hyper-V, WSL, VPN).
  const preferred = candidates.find((c) => /^(192\.168\.|10\.)/.test(c.address)
    && !/virtual|vethernet|wsl|loopback|vmware|vbox/i.test(c.name));
  return (preferred || candidates[0] || { address: '127.0.0.1', name: 'loopback' });
}

let ifaceCache = { value: lanAddress(), at: Date.now() };
const bootAddress = ifaceCache.value.address;
let lastReported = bootAddress;

/**
 * The live LAN address, re-read rather than captured at boot.
 *
 * DHCP can hand this machine a different address while the server is running.
 * Resolving once at startup meant the QR code and the Join Info panel kept
 * advertising an address that no longer existed. Cached for a second so the
 * per-request cost stays negligible.
 *
 * `onChange` is called with (previous, next) so the caller can shout about it.
 */
function currentIface(onChange) {
  if (Date.now() - ifaceCache.at > 1000) {
    const fresh = lanAddress();
    ifaceCache = { value: fresh, at: Date.now() };
    if (fresh.address !== lastReported) {
      const previous = lastReported;
      lastReported = fresh.address;
      if (typeof onChange === 'function') onChange(previous, fresh.address);
    }
  }
  return ifaceCache.value;
}

/* ------------------------------------------------------------------ *
 * Public origin
 * ------------------------------------------------------------------ */

/**
 * Origin reconstructed from proxy headers, or null when there is no trustworthy
 * proxy in front. Express has already validated these against `trust proxy`, so
 * `req.protocol` and `req.hostname` only reflect the headers when we said a
 * proxy may set them.
 */
function forwardedOrigin(req) {
  if (!req || trustProxySetting() === false) return null;
  const forwardedHost = req.get ? req.get('x-forwarded-host') : null;
  // Only the presence of a forwarded host proves a proxy actually handled this
  // request. Falling back to the plain Host header would make every LAN request
  // look "public" and advertise an unreachable address to the class.
  if (!forwardedHost) return null;
  const host = String(forwardedHost).split(',')[0].trim();
  if (!host) return null;
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return normalizeUrl(`${proto}://${host}`);
}

/**
 * Everything the admin console and the QR endpoint need to tell students where
 * to go. `req` is optional — the boot banner has no request to work from.
 */
function joinInfo(port, req, onChange) {
  const iface = currentIface(onChange);
  const suffix = Number(port) === 80 ? '' : `:${port}`;
  const lanUrl = `http://${iface.address}${suffix}`;
  const publicUrl = PUBLIC_URL || forwardedOrigin(req);
  const url = publicUrl || lanUrl;

  return {
    mode: publicUrl ? 'internet' : 'lan',
    url,
    publicUrl: publicUrl || null,
    lanUrl,
    secure: url.startsWith('https://'),
    // Kept for the LAN join panel and `npm run netcheck`.
    host: iface.address,
    port: Number(port),
    interface: iface.name,
    changedSinceStart: iface.address !== bootAddress,
    bootAddress,
  };
}

module.exports = {
  PUBLIC_URL,
  INTERNET_MODE,
  trustProxySetting,
  normalizeUrl,
  lanAddress,
  currentIface,
  forwardedOrigin,
  joinInfo,
  bootAddress,
};
