'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { buildRouter } = require('./src/routes');
const { createStaticServer } = require('./src/static');
const { attachRealtime } = require('./src/realtime');
const auth = require('./src/auth');
const origin = require('./src/origin');
const { DB_FILE } = require('./src/db');

/**
 * Port resolution: `--port 80` / `-p 80` beats PORT beats 3000.
 * A CLI flag is used because `PORT=80 npm start` does not work in Windows cmd.
 * Hosting platforms inject PORT, so the environment variable is what they use.
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
const INTERNET = origin.INTERNET_MODE;

/**
 * Redirect plaintext requests to HTTPS.
 *
 * On by default once PUBLIC_URL is an https address, because the exam token, the
 * admin password and every answer travel inside these requests. Set FORCE_HTTPS=0
 * if TLS is terminated somewhere that does not set X-Forwarded-Proto and the
 * redirect would loop.
 */
const FORCE_HTTPS = process.env.FORCE_HTTPS
  ? process.env.FORCE_HTTPS !== '0' && process.env.FORCE_HTTPS !== 'false'
  : (INTERNET && String(origin.PUBLIC_URL).startsWith('https://'));

/** Shouts when DHCP moves this machine mid-exam. LAN deployments only. */
function announceAddressChange(previous, next) {
  if (INTERNET) return; // students use the public name; the local IP is noise
  console.log(`\n  *** THIS MACHINE'S ADDRESS CHANGED: ${previous} -> ${next} ***`);
  console.log(`  Students must now use: http://${next}${PORT === 80 ? '' : `:${PORT}`}`);
  console.log('  The admin Join Info tab and QR code have updated themselves.');
  console.log('  Reserve a fixed address for this machine to stop this recurring.\n');
}

/** Where students should point their browser, for this request. */
const joinInfo = (req) => origin.joinInfo(PORT, req, announceAddressChange);

const app = express();
app.disable('x-powered-by');

/**
 * Behind a proxy the socket's peer is the proxy — so without this every client
 * shares one rate-limit bucket and every log line names the load balancer.
 * Left off on a LAN, where trusting X-Forwarded-For would let any student spoof
 * their own address.
 */
app.set('trust proxy', origin.trustProxySetting());

// Generous limit: an admin saving a quiz sends every question image inline as
// base64. Student-facing payloads stay tiny — images are fetched by URL.
app.use(express.json({ limit: '64mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing here should ever be framed: an exam in an iframe is a clickjacking
  // surface and undermines the fullscreen lockdown.
  "frame-ancestors 'none'",
  "script-src 'self'",
  // The pages carry no inline <script>, but they do use style attributes and
  // the dashboard sets styles from JS.
  "style-src 'self' 'unsafe-inline'",
  // data: for question images pasted into the editor, blob: for generated PDFs.
  "img-src 'self' data: blob:",
  "object-src 'self' blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws: wss: blob:",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // The exam needs none of these, and denying them removes a whole class of
  // permission prompts — each of which blurs the window and would otherwise
  // terminate somebody's attempt.
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  // Only meaningful, and only honoured, over TLS.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

/**
 * Liveness probe. Answered before the HTTPS redirect and before any auth,
 * because hosting platforms check it over plaintext on an internal address and
 * a redirect there reads as a failed deploy.
 */
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    mode: INTERNET ? 'internet' : 'lan',
    uptime: Math.round(process.uptime()),
  });
});

if (FORCE_HTTPS) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    // 308 rather than 302: a redirected POST must stay a POST, or an auto-submit
    // arriving over http would be downgraded to a GET and the student's answers
    // would vanish without an error anyone could see.
    const base = origin.PUBLIC_URL || `https://${req.get('host') || ''}`;
    return res.redirect(308, `${base}${req.originalUrl}`);
  });
}

// `no-store` applies to the API only. Applying it to every response — as this
// once did — meant each phone re-downloaded the whole CSS/JS shell on every
// navigation, which is the last thing you want on a shared Wi-Fi radio.
// Static assets set their own validators in src/static.js.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use('/api', buildRouter());

/**
 * The join address, for the admin console's Join Info panel.
 *
 * On a LAN this reports the machine's interface and IPv4 address, which is
 * exactly what an invigilator needs to debug "nobody can connect". Once the
 * system is on a public address that detail is internal topology of no use to
 * anybody legitimate, so it is withheld and only the public URL is reported.
 */
app.get('/api/network', auth.requireAdmin, (req, res) => {
  const info = joinInfo(req);
  if (info.mode === 'internet') {
    return res.json({
      mode: 'internet',
      url: info.url,
      secure: info.secure,
      port: info.port,
      changedSinceStart: false,
    });
  }
  return res.json({
    mode: 'lan',
    host: info.host,
    port: info.port,
    url: info.url,
    interface: info.interface,
    secure: info.secure,
    // Lets the dashboard warn that a projected QR code is now out of date.
    changedSinceStart: info.changedSinceStart,
    bootAddress: info.bootAddress,
  });
});

/**
 * PNG QR code of the student join URL, for projecting on screen.
 *
 * Administrator only, like the Join Info panel it belongs to. An <img> tag
 * cannot send an Authorization header, so the token arrives as `?adminToken=`
 * — the same mechanism the CSV and PDF exports already use.
 */
app.get('/api/qr.png', auth.requireAdmin, async (req, res) => {
  try {
    const png = await QRCode.toBuffer(joinInfo(req).url, {
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
app.get('/teacher', (req, res) => assets.sendFile(req, res, 'teacher.html'));
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
  // Same-origin only. The exam is served from the host it talks to, so there is
  // no legitimate cross-origin socket — and allowing one would let any page on
  // the internet drive a student's live exam session.
  cors: { origin: false },
  // Relaxed from 10s/8s. Every ping wakes a phone's Wi-Fi radio, and with 60
  // devices the chatter costs latency and battery for no benefit — presence is
  // only a dashboard display, never part of anti-cheat enforcement.
  //
  // Over the internet the timeout also has to survive a mobile handover between
  // cells, or from Wi-Fi to 4G, which can stall a connection for several seconds
  // without actually breaking it.
  pingInterval: 25_000,
  pingTimeout: 30_000,
  // WebSocket first, but long-polling stays enabled: corporate proxies, some
  // captive portals and a few mobile carriers still break WebSocket upgrades,
  // and a student on such a network must still be able to sit the exam.
  transports: ['websocket', 'polling'],
  // Small JSON frames; per-message deflate costs more CPU than it saves.
  perMessageDeflate: false,
  httpCompression: true,
  // A phone that loses signal mid-exam resumes its session instead of arriving
  // as a fresh socket that has to re-join. Two minutes covers a tunnel or a lift.
  connectionStateRecovery: {
    maxDisconnectionDuration: 120_000,
    skipMiddlewares: true,
  },
});
attachRealtime(io);

server.listen(PORT, HOST, async () => {
  if (process.env.QUIET === '1') return; // test runs
  const info = joinInfo(null);
  const url = info.url;
  let qr = '';
  try {
    qr = await QRCode.toString(url, { type: 'terminal', small: true });
  } catch { /* terminal QR is a convenience only */ }

  // ASCII only: Windows consoles on a legacy codepage garble box-drawing glyphs.
  const line = '='.repeat(58);
  const mode = info.mode === 'internet' ? 'INTERNET' : 'LOCAL WIFI';
  console.log(`\n${line}`);
  console.log(`  EXAM SYSTEM - running (${mode} mode)`);
  console.log(line);
  console.log(`  Student portal : ${url}`);
  console.log(`  Teacher panel  : ${url}/teacher`);
  console.log(`  Admin console  : ${url}/admin`);
  console.log(`  Listening on   : ${HOST}:${PORT}`);
  console.log(`  Database       : ${DB_FILE}`);
  console.log(line);

  if (info.mode === 'internet') {
    console.log('  Students can join from any internet connection - mobile data,');
    console.log('  home broadband, another building. No shared network needed.');
    if (!info.secure) {
      console.log('');
      console.log('  WARNING: PUBLIC_URL is http://, not https://. Exam tokens, the');
      console.log('  admin password and every answer cross the internet in the clear.');
      console.log('  Put TLS in front of this before running a real exam.');
    }
    console.log(line);
    console.log('  Give every quiz an ACCESS CODE in the admin console. A join URL');
    console.log('  gets forwarded and screenshotted; the code is what keeps strangers out.');
    console.log(line);
    console.log('  ADMIN PASSWORD : read from ADMIN_PASSWORD. Not printed here -');
    console.log('                   a hosting platform log is rarely private.');
  } else {
    console.log(`  Local (host)   : http://localhost${PORT === 80 ? '' : `:${PORT}`}`);
    console.log(`  Interface      : ${info.interface} (${info.host})`);
    if (PORT === 80) {
      console.log(`  Students type : ${info.host}      (no port, no http:// needed)`);
    } else {
      console.log(`  Students MUST type the "http://" part: ${url}`);
      console.log(`  Phones treat "${info.host}:${PORT}" as a web search and fail.`);
      console.log('  Easier: stop this and run  npm run start:80');
      console.log(`  Then students just type: ${info.host}`);
    }
    console.log(line);
    console.log('  To let students join from ANY internet connection instead, see');
    console.log('  DEPLOY.md - one command with a tunnel, or a free cloud host.');
    console.log(line);
    // Always print the live password: it is the only place the invigilator can
    // read it, and copying the placeholder out of the README is a known mistake.
    console.log(`  ADMIN PASSWORD : ${auth.PASSWORD}          <-- use THIS`);
    const source = {
      env: 'from the ADMIN_PASSWORD environment variable',
      stored: 'saved in the database - stable across restarts',
      generated: 'generated now and saved - it will stay the same next boot',
    }[auth.SOURCE];
    console.log(`  (${source})`);
    console.log('  Change it with: npm run password -- <new-password>');
  }

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
