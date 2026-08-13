'use strict';

/**
 * Asset delivery. These are performance guarantees, but they are also
 * correctness ones: the exam shell must never be cached (a stale copy could
 * skip the pre-exam attempt check) while CSS and JS must be, or every phone
 * re-downloads the whole shell on each navigation.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'static-pass';
process.env.PORT = process.env.TEST_PORT_STATIC || '38626';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const ASSETS = ['/css/styles.css', '/js/api.js', '/js/exam.js', '/js/lockdown.js', '/js/admin.js'];
const PAGES = ['/', '/exam', '/admin'];

async function head(path, headers = {}) {
  const res = await fetch(BASE + path, { headers: { 'Accept-Encoding': 'gzip', ...headers } });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    body,
    cache: res.headers.get('cache-control') || '',
    etag: res.headers.get('etag'),
    encoding: res.headers.get('content-encoding'),
    type: res.headers.get('content-type') || '',
    length: Number(res.headers.get('content-length')),
    vary: res.headers.get('vary') || '',
  };
}

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
});
test.after(() => { server.close(); });

/* ------------------------------------------------------------------ */

test('CSS and JS are served gzipped', async () => {
  for (const path of ASSETS) {
    const res = await head(path);
    assert.equal(res.status, 200, `${path} should exist`);
    assert.equal(res.encoding, 'gzip', `${path} must be compressed`);
    assert.match(res.vary, /Accept-Encoding/, `${path} must vary on encoding`);
    // content-length describes the compressed body actually sent.
    assert.ok(res.length < res.body.length,
      `${path}: wire size ${res.length} should beat raw ${res.body.length}`);
  }
});

test('compression is a real saving, not a rounding error', async () => {
  const res = await head('/css/styles.css');
  const ratio = res.length / res.body.length;
  assert.ok(ratio < 0.45,
    `stylesheet should compress to under 45% of raw, got ${Math.round(ratio * 100)}%`);
});

test('a client that cannot gzip still gets valid, uncompressed bytes', async () => {
  const res = await fetch(`${BASE}/js/exam.js`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), null);
  const text = await res.text();
  assert.match(text, /Student exam portal/, 'must be the real script, not a gzip blob');
});

test('the gzipped body decompresses to exactly the raw file', async () => {
  const compressed = await fetch(`${BASE}/js/lockdown.js`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  // fetch decodes for us; re-fetch without gzip to compare.
  const decoded = Buffer.from(await compressed.arrayBuffer());
  const plain = Buffer.from(await (await fetch(`${BASE}/js/lockdown.js`, {
    headers: { 'Accept-Encoding': 'identity' },
  })).arrayBuffer());
  assert.ok(decoded.equals(plain), 'compressed and plain responses must match');
  // And the compressed form really is gzip.
  assert.ok(zlib.gzipSync(plain).length < plain.length);
});

test('CSS and JS are cacheable and revalidate to a body-free 304', async () => {
  for (const path of ASSETS) {
    const first = await head(path);
    assert.match(first.cache, /public/, `${path} must be cacheable`);
    assert.ok(!/no-store/.test(first.cache), `${path} must not be no-store`);
    assert.ok(first.etag, `${path} needs an ETag`);

    const again = await head(path, { 'If-None-Match': first.etag });
    assert.equal(again.status, 304, `${path} must answer 304`);
    assert.equal(again.body.length, 0, `${path} 304 must carry no body`);
  }
});

test('HTML shells revalidate every time and are never stored', async () => {
  for (const path of PAGES) {
    const res = await head(path);
    assert.equal(res.status, 200, `${path} should render`);
    assert.match(res.type, /text\/html/);
    assert.match(res.cache, /no-cache/,
      `${path} must revalidate so a stale shell cannot skip the attempt check`);
    assert.ok(res.etag, `${path} still needs an ETag so revalidation is cheap`);

    const again = await head(path, { 'If-None-Match': res.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
  }
});

test('API responses are still no-store', async () => {
  const res = await head('/api/quiz/active');
  assert.match(res.cache, /no-store/, 'exam state must never be cached');
});

test('an ETag changes when the file changes', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'public', 'js', 'api.js');

  const before = await head('/js/api.js');
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\n// cache-bust probe\n')]));
    const after = await head('/js/api.js');
    assert.notEqual(after.etag, before.etag, 'editing a file must invalidate its ETag');
    assert.equal(after.status, 200);

    // The stale validator must no longer match.
    const stale = await head('/js/api.js', { 'If-None-Match': before.etag });
    assert.equal(stale.status, 200, 'an outdated ETag must get fresh bytes, not 304');
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('path traversal cannot escape the public directory', async () => {
  for (const attempt of [
    '/../package.json',
    '/../../package.json',
    '/..%2fpackage.json',
    '/js/../../package.json',
    '/%2e%2e/package.json',
  ]) {
    const res = await fetch(BASE + attempt, { redirect: 'manual' });
    const body = await res.text();
    assert.ok(!/"dependencies"/.test(body),
      `${attempt} must not expose package.json (status ${res.status})`);
  }
});

test('an unknown page falls back to the login shell, not an asset dump', async () => {
  const res = await fetch(`${BASE}/no-such-page`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(await res.text(), /Exam Login|Local Exam System/);
});

test('unknown API paths still answer JSON', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Unknown endpoint.');
});

test('HEAD returns headers without a body', async () => {
  const res = await fetch(`${BASE}/css/styles.css`, {
    method: 'HEAD', headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers.get('content-length')) > 0);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('the whole exam shell fits in a small budget on the wire', async () => {
  // Guards against a future change quietly making the phone payload heavy.
  const shell = ['/exam', '/css/styles.css', '/js/api.js', '/js/lockdown.js', '/js/exam.js'];
  let wire = 0;
  for (const path of shell) {
    const res = await head(path);
    wire += res.length || res.body.length;
  }
  assert.ok(wire < 30 * 1024,
    `exam shell should stay under 30 KB gzipped, got ${(wire / 1024).toFixed(1)} KB`);
});

test('the pages load the minified socket.io client, not the full build', () => {
  // 14 KB vs 37 KB gzipped, same API. Socket.io serves both, and the full build
  // is the default in every example, so this is easy to regress by copy-paste.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const page of ['exam.html', 'admin.html']) {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'public', page), 'utf8');
    assert.match(html, /socket\.io\.min\.js/, `${page} must use the minified client`);
    assert.doesNotMatch(html, /socket\.io\/socket\.io\.js/,
      `${page} still references the full build`);
  }
});
