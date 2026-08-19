'use strict';

/**
 * Internet mode — what changes the moment PUBLIC_URL is set.
 *
 * This runs as its own process because the switch is read once, at load: every
 * decision below (which address to advertise, whether to demand TLS, whether the
 * admin password may be generated) is fixed before the first request arrives.
 */

process.env.DB_FILE = ':memory:';
process.env.PUBLIC_URL = 'https://exam.example.test';
process.env.ADMIN_PASSWORD = 'a-properly-long-admin-password';
process.env.PORT = process.env.TEST_PORT_NET_PUBLIC || '38633';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server, app } = require('../server');
const auth = require('../src/auth');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

// What a request looks like after a load balancer has terminated TLS for it.
const VIA_PROXY = {
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'exam.example.test',
};

let adminToken;

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...VIA_PROXY },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  adminToken = (await res.json()).token;
  assert.ok(adminToken, 'the suite needs an administrator session');
});
test.after(() => { server.close(); });

/* ================= The address students are given ================= */

test('the join address is the public URL, not this machine\'s own IP', async () => {
  const res = await fetch(`${BASE}/api/network`, { headers: { ...VIA_PROXY, Authorization: `Bearer ${adminToken}` } });
  const net = await res.json();
  assert.equal(net.mode, 'internet');
  assert.equal(net.url, 'https://exam.example.test');
  assert.equal(net.secure, true);
});

test('internal network topology is withheld once the app is public', async () => {
  const net = await (await fetch(`${BASE}/api/network`, { headers: { ...VIA_PROXY, Authorization: `Bearer ${adminToken}` } })).json();
  assert.equal(net.host, undefined, 'a private LAN address helps nobody outside it');
  assert.equal(net.interface, undefined);
  assert.equal(net.bootAddress, undefined);
});

test('the DHCP warning is not raised against a hostname that cannot move', async () => {
  const net = await (await fetch(`${BASE}/api/network`, { headers: { ...VIA_PROXY, Authorization: `Bearer ${adminToken}` } })).json();
  assert.equal(net.changedSinceStart, false);
});

test('the QR code still renders, and is never cached', async () => {
  const res = await fetch(`${BASE}/api/qr.png?adminToken=${adminToken}`, { headers: VIA_PROXY });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.ok((await res.arrayBuffer()).byteLength > 100);
});

/* ================= Transport ================= */

test('plaintext requests are redirected to the https address', async () => {
  const res = await fetch(`${BASE}/exam`, { redirect: 'manual' });
  assert.equal(res.status, 308,
    '308 keeps the method: a redirected auto-submit must not become a GET');
  assert.equal(res.headers.get('location'), 'https://exam.example.test/exam');
});

test('the redirect preserves the whole path and query', async () => {
  const res = await fetch(`${BASE}/api/quiz/image/7?t=abc`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), 'https://exam.example.test/api/quiz/image/7?t=abc');
});

test('the health probe answers over plaintext, ahead of the redirect', async () => {
  // Platforms check this on an internal http address. A redirect here reads as
  // a failed deploy and the release gets rolled back.
  const res = await fetch(`${BASE}/api/health`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'internet');
});

test('a request that arrived over TLS is served, and pinned with HSTS', async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: VIA_PROXY, redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d+/);
});

test('the proxy in front is trusted for exactly one hop', () => {
  assert.equal(app.get('trust proxy'), 1,
    'untrusted, every student shares one rate-limit bucket; over-trusted, any '
    + 'client can forge its own address');
});

/* ================= Credentials ================= */

test('the admin password comes from the environment and is never printed', () => {
  assert.equal(auth.SOURCE, 'env');
  assert.equal(auth.PRINTABLE, false,
    'a hosting platform log is not a private place to publish a password');
});

test('the stored-password tool refuses to pretend it can change this one', () => {
  assert.throws(() => auth.setStoredPassword('another-long-password'),
    /environment/i,
    'saving a password the deployment ignores would leave the old one working');
});
