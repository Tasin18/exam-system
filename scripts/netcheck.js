'use strict';

/**
 * Diagnoses "students cannot open the portal".
 *
 *   npm run netcheck            check the default port
 *   npm run netcheck -- 80      check port 80
 *
 * Reports every address students could use, whether the server answers on it,
 * and the platform-specific things that usually block a phone.
 */

const os = require('node:os');
const net = require('node:net');
const http = require('node:http');

// Set when this exam is published to the internet rather than a local network.
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/[/]+$/, '');

const portArg = Number(process.argv[2]);
const PORT = Number.isInteger(portArg) && portArg > 0
  ? portArg
  : (Number(process.env.PORT) || 3000);
const suffix = PORT === 80 ? '' : `:${PORT}`;

function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

const isLinkLocal = (ip) => ip.startsWith('169.254.');
const isPrivate = (ip) => /^(192\.168\.|10\.)/.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** Is anything listening on this port? */
function probePort(host) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(PORT, host);
  });
}

/** Fetches and parses a JSON endpoint, or resolves null. */
function probeJson(path, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host, port: PORT, path, timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Does the exam API actually answer? */
const probeApi = (host) => probeJson('/api/quiz/active', host);

/**
 * Checks the published address end to end.
 *
 * Everything below this only proves the server answers on the local network,
 * which tells you nothing about whether a student on mobile data can reach it.
 * The one question that matters for a public deployment is whether the address
 * on the QR code resolves, terminates TLS and arrives at this process - so ask
 * it the same way a student's phone would.
 */
async function checkPublic(line) {
  console.log(`\n${line}`);
  console.log('  PUBLIC ADDRESS');
  console.log(line);
  console.log(`\n  Students open : ${PUBLIC_URL}`);

  if (!PUBLIC_URL.startsWith('https://')) {
    console.log('  WARNING       : this is plain http. Answers and the admin password');
    console.log('                  cross the internet unencrypted.');
  }

  try {
    const res = await fetch(`${PUBLIC_URL}/api/health`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'cache-control': 'no-cache' },
    });
    const body = await res.json().catch(() => ({}));
    const reachable = res.ok && body.ok;
    console.log(`  Reachable     : ${reachable ? 'yes' : 'NO'}`);
    if (reachable && body.mode !== 'internet') {
      console.log('  MISMATCH      : the server that answered is NOT in internet mode.');
      console.log('                  PUBLIC_URL is set in this shell but not in the');
      console.log('                  environment the server was actually started with,');
      console.log('                  so it is still advertising a local address.');
    }
    if (!reachable) {
      console.log(`  HTTP status   : ${res.status}`);
      console.log('  -> The address resolves but the exam server did not answer.');
      console.log('     Check the tunnel or the host is still running.');
    }
  } catch (err) {
    console.log('  Reachable     : NO');
    console.log(`  Error         : ${err.message}`);
    console.log('  -> Nothing answered there. Check the hostname is spelled correctly,');
    console.log('     that DNS has propagated, and that the deployment is running.');
  }
}

async function main() {
  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log(`  NETWORK CHECK  (port ${PORT})`);
  console.log(line);

  if (PUBLIC_URL) await checkPublic(line);

  const running = await probePort('127.0.0.1');
  console.log(`\n  Server running on port ${PORT}? ${running ? 'YES' : 'NO'}`);
  if (!running) {
    console.log(`  -> Start it first:  npm start${PORT === 80 ? ':80' : ''}`);
  }

  const active = running ? await probeApi('127.0.0.1') : null;
  if (active) {
    console.log(active.active
      ? `  Active quiz: "${active.title}" (${active.questionCount} questions)`
      : '  No quiz is active yet - activate one in the admin console.');
  }

  // The most common cause of a sudden "site can't be reached" for everyone at
  // once: DHCP moved this machine while the exam was already set up.
  const net = running ? await probeJson('/api/network') : null;
  if (net && net.changedSinceStart) {
    console.log(`\n  *** ADDRESS CHANGED SINCE THE SERVER STARTED ***`);
    console.log(`  was ${net.bootAddress}, now ${net.host}`);
    console.log('  Any printed sheet, photographed QR code or student bookmark showing');
    console.log(`  the old address will fail. Students must now use: ${net.url}`);
    console.log('  Ask for a fixed (reserved) address for this machine.');
  }

  const list = interfaces();
  const usable = list.filter((i) => isPrivate(i.address));
  const linkLocal = list.filter((i) => isLinkLocal(i.address));

  console.log(`\n${line}`);
  console.log('  ADDRESSES STUDENTS CAN USE');
  console.log(line);

  if (!usable.length) {
    console.log('\n  None found. This machine has no private LAN address -');
    console.log('  connect it to the Wi-Fi network the students will use.');
  }

  for (const iface of usable) {
    const reachable = running ? await probePort(iface.address) : false;
    console.log(`\n  ${iface.name}`);
    console.log(`    Students type : ${iface.address}${suffix}`);
    console.log(`    Full URL      : http://${iface.address}${suffix}`);
    console.log(`    Reachable     : ${reachable ? 'yes' : 'NO'}`);
    if (PORT !== 80) {
      console.log('    Note          : phones often treat "ip:port" as a search.');
      console.log('                    Students must include http:// - or use'
        + ' npm run start:80');
    }
  }

  if (linkLocal.length) {
    console.log(`\n  Ignore these ${linkLocal.length} link-local address(es) `
      + '(169.254.x.x - Bluetooth/virtual adapters);');
    console.log('  they are never reachable by students.');
  }

  console.log(`\n${line}`);
  console.log('  IF A PHONE STILL CANNOT CONNECT');
  console.log(line);
  if (PUBLIC_URL) {
    console.log('\n  This exam is published at the address above, so the local addresses');
    console.log('  listed here only matter for someone sitting in the same room.');
  }
  console.log('\n  1. Phone on Wi-Fi, not mobile data, and on the SAME network.');
  console.log('  2. Type the address exactly - include http:// when a port is used.');
  console.log('  3. Scan the QR code instead of typing (it encodes the full URL).');
  console.log('  4. Router "AP isolation" / "client isolation" blocks device-to-device');
  console.log('     traffic. Common on guest Wi-Fi. Turn it off, or use a hotspot.');

  if (process.platform === 'win32') {
    console.log('\n  5. Windows Firewall - allow Node.js inbound (run as Administrator):');
    console.log(`       netsh advfirewall firewall add rule name="Exam System ${PORT}" `
      + `dir=in action=allow protocol=TCP localport=${PORT}`);
    console.log('     If Windows ever showed a "Allow Node.js?" prompt and it was');
    console.log('     dismissed, this rule is what fixes it.');
  }

  console.log(`\n${line}\n`);
}

main();
