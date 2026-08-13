'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { buildRouter } = require('./src/routes');
const { createStaticServer } = require('./src/static');
const { attachRealtime } = require('./src/realtime');
const adminAuth = require('./src/admin-auth');
const { DB_FILE } = require('./src/db');

/**
 * Port resolution: `--port 80` / `-p 80` beats PORT beats 3000.
 * A CLI flag is used because `PORT=80 npm start` does not work in Windows cmd.
 */
function resolvePort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--port' && args[i] !== '-p') continue;
    const value = Number(args[i + 1]);
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
    console.error(`  Invalid --port value: ${args[i + 1]}`);
    process.exit(1);
  }
  return Number(process.env.PORT) || 3000;
}

const PORT = resolvePort();
const HOST = process.env.HOST || '0.0.0.0';

/** First non-internal IPv4 address — the one students type into their browser. */
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

/**
 * The live LAN address, re-read rather than captured at boot.
 *
 * DHCP can hand this machine a different address while the server is running.
 * Resolving once at startup meant the QR code and the Join Info panel kept
 * advertising an address that no longer existed, and every phone got "site
 * can't be reached" with nothing in the logs to explain it.
 *
 * Cached for a second so per-request cost stays negligible.
 */
let ifaceCache = { value: lanAddress(), at: Date.now() };
const bootAddress = ifaceCache.value.address;
let lastReported = bootAddress;

function currentIface() {
  if (Date.now() - ifaceCache.at > 1000) {
    const fresh = lanAddress();
    ifaceCache = { value: fresh, at: Date.now() };
    if (fresh.address !== lastReported) {
      // Loud, because every student's bookmark and the projected QR just died.
      console.log(`\n  *** THIS MACHINE'S ADDRESS CHANGED: ${lastReported}`
        + ` -> ${fresh.address} ***`);
      console.log(`  Students must now use: http://${fresh.address}`
        + `${PORT === 80 ? '' : `:${PORT}`}`);
      console.log('  The admin Join Info tab and QR code have updated themselves.');
      console.log('  Reserve a fixed address for this machine to stop this recurring.\n');
      lastReported = fresh.address;
    }
  }
  return ifaceCache.value;
}

const app = express();
app.disable('x-powered-by');
// Generous limit: an admin saving a quiz sends every question image inline as
// base64. Student-facing payloads stay tiny — images are fetched by URL.
app.use(express.json({ limit: '64mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// `no-store` applies to the API only. Applying it to every response — as this
// once did — meant each phone re-downloaded the whole CSS/JS shell on every
// navigation, which is the last thing you want on a shared Wi-Fi radio.
// Static assets set their own validators in src/static.js.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use('/api', buildRouter());

// Port 80 is omitted so students can type a bare IP. Mobile browsers navigate a
// bare IP as http://, but treat "ip:3000" as a search term or force HTTPS.
const suffix = PORT === 80 ? '' : `:${PORT}`;
const baseUrl = () => `http://${currentIface().address}${suffix}`;

app.get('/api/network', (req, res) => {
  const iface = currentIface();
  res.json({
    host: iface.address,
    port: PORT,
    url: baseUrl(),
    interface: iface.name,
    // Lets the dashboard warn that a projected QR code is now out of date.
    changedSinceStart: iface.address !== bootAddress,
    bootAddress,
  });
});

/** PNG QR code of the student join URL, for projecting on screen. */
app.get('/api/qr.png', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(baseUrl(), {
      type: 'png', width: 360, margin: 2, errorCorrectionLevel: 'M',
    });
    res.setHeader('Content-Type', 'image/png');
    // The encoded URL can change with DHCP, so this must never be cached.
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'Could not render QR code.' });
  }
});

const assets = createStaticServer(path.join(__dirname, 'public'));
app.use(assets.middleware);

app.get('/admin', (req, res) => assets.sendFile(req, res, 'admin.html'));
app.get('/exam', (req, res) => assets.sendFile(req, res, 'exam.html'));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unknown endpoint.' });
  res.status(404);
  assets.sendFile(req, res, 'index.html');
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  // Relaxed from 10s/8s. Every ping wakes a phone's Wi-Fi radio, and with 60
  // devices the chatter costs latency and battery for no benefit — presence is
  // only a dashboard display, never part of anti-cheat enforcement.
  pingInterval: 25_000,
  pingTimeout: 20_000,
  // Skip the HTTP long-poll handshake and go straight to a WebSocket.
  transports: ['websocket', 'polling'],
  // Small JSON frames; per-message deflate costs more CPU than it saves.
  perMessageDeflate: false,
  httpCompression: true,
});
attachRealtime(io);

server.listen(PORT, HOST, async () => {
  if (process.env.QUIET === '1') return; // test runs
  const url = baseUrl();
  let qr = '';
  try {
    qr = await QRCode.toString(url, { type: 'terminal', small: true });
  } catch { /* terminal QR is a convenience only */ }

  // ASCII only: Windows consoles on a legacy codepage garble box-drawing glyphs.
  const line = '='.repeat(58);
  const iface = currentIface();
  console.log(`\n${line}`);
  console.log('  LOCAL WIFI EXAM SYSTEM - running');
  console.log(line);
  console.log(`  Student portal : ${url}`);
  console.log(`  Admin console  : ${url}/admin`);
  console.log(`  Local (host)   : http://localhost${suffix}`);
  console.log(`  Interface      : ${iface.name} (${iface.address})`);
  console.log(`  Database       : ${DB_FILE}`);
  console.log(line);
  if (PORT === 80) {
    console.log(`  Students type : ${iface.address}      (no port, no http:// needed)`);
  } else {
    console.log(`  Students MUST type the "http://" part: ${url}`);
    console.log('  Phones treat "' + iface.address + suffix + '" as a web search and fail.');
    console.log('  Easier: stop this and run  npm run start:80');
    console.log(`  Then students just type: ${iface.address}`);
  }
  console.log(line);
  // Always print the live password: it is the only place the invigilator can
  // read it, and copying the placeholder out of the README is a known mistake.
  console.log(`  ADMIN PASSWORD : ${adminAuth.PASSWORD}          <-- use THIS`);
  const origin = {
    env: 'from the ADMIN_PASSWORD environment variable',
    stored: 'saved in the database - stable across restarts',
    generated: 'generated now and saved - it will stay the same next boot',
  }[adminAuth.SOURCE];
  console.log(`  (${origin})`);
  console.log('  Change it with: npm run password -- <new-password>');
  console.log(line);
  if (qr) {
    console.log('  Students: scan to join\n');
    console.log(qr);
  }
  console.log(`${line}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Start with a different port:\n`
      + `    PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown(signal) {
  console.log(`\n  ${signal} received — shutting down.`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server, io };
