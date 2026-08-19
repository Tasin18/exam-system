'use strict';

/**
 * Join-address reporting.
 *
 * DHCP can move this machine to a different address while the server is running.
 * When that happened the address was only resolved once at boot, so the QR code
 * and the Join Info panel kept advertising an address that no longer existed and
 * every phone reported "site can't be reached" with nothing in the logs.
 */

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'net-pass';
process.env.PORT = process.env.TEST_PORT_NET || '38627';
process.env.QUIET = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { once } = require('node:events');

const { server } = require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

// The join panel describes how to reach this machine, so it is behind the
// administrator password now rather than open to anyone who can load the page.
let adminToken;

test.before(async () => {
  if (!server.listening) await once(server, 'listening');
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
  });
  adminToken = (await res.json()).token;
  assert.ok(adminToken, 'the suite needs an administrator session');
});
test.after(() => { server.close(); });

async function network() {
  const res = await fetch(`${BASE}/api/network`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

/* ------------------------------------------------------------------ */

test('the network endpoint reports a usable join address', async () => {
  const net = await network();
  assert.match(net.host, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(net.port, Number(process.env.PORT));
  assert.equal(net.url, `http://${net.host}:${net.port}`);
  assert.ok(net.interface, 'the interface name helps identify the right adapter');
  assert.equal(net.changedSinceStart, false);
  assert.equal(net.bootAddress, net.host);
});

test('the address is re-read, not captured once at boot', async () => {
  const before = await network();

  // Simulate DHCP handing this machine a different address.
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.77.55' }],
  });

  try {
    // The lookup is cached for a second, so wait it out rather than assuming.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await network();

    assert.equal(after.host, '192.168.77.55',
      'a new address must be picked up without a restart');
    assert.equal(after.url, `http://192.168.77.55:${after.port}`);
    assert.equal(after.changedSinceStart, true,
      'the dashboard needs to know the projected QR code is now wrong');
    assert.equal(after.bootAddress, before.host,
      'the original address is reported so the warning can name both');
  } finally {
    os.networkInterfaces = real;
  }
});

test('the QR code encodes the current address and is never cached', async () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '10.1.2.3' }],
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const net = await network();
    assert.equal(net.host, '10.1.2.3');

    const qr = await fetch(`${BASE}/api/qr.png?adminToken=${adminToken}`);
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/png');
    // A cached QR would keep sending students to a dead address.
    assert.match(qr.headers.get('cache-control') || '', /no-store/);
    assert.ok((await qr.arrayBuffer()).byteLength > 100);
  } finally {
    os.networkInterfaces = real;
  }
});

test('link-local and internal addresses are not offered to students', async () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    'Bluetooth Network Connection': [
      { family: 'IPv4', internal: false, address: '169.254.228.49' }],
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.1.1' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.0.102' }],
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const net = await network();
    assert.equal(net.host, '192.168.0.102',
      'the real Wi-Fi address must win over Bluetooth and WSL adapters');
    assert.equal(net.interface, 'Wi-Fi');
  } finally {
    os.networkInterfaces = real;
  }
});

test('a host with only virtual adapters still reports something usable', async () => {
  const real = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'vEthernet (Default Switch)': [
      { family: 'IPv4', internal: false, address: '172.30.5.1' }],
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const net = await network();
    assert.equal(net.host, '172.30.5.1', 'fall back rather than reporting nothing');
  } finally {
    os.networkInterfaces = real;
  }
});
