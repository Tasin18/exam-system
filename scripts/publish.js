'use strict';

/**
 * Puts this exam server on the public internet from the machine it is already
 * running on.
 *
 *   npm run publish              default port
 *   npm run publish -- --port 8080
 *
 * A Cloudflare quick tunnel dials out to Cloudflare and gets a public https
 * address back, so students on mobile data or another network reach the exam
 * without anybody opening a firewall port, forwarding anything on the router,
 * or having a fixed IP address. The exam and its database never leave this
 * machine — only the traffic is relayed.
 *
 * What this is not: a permanent address. The hostname is randomly assigned and
 * changes every time this command runs, and the tunnel dies with this terminal.
 * That is right for a one-off sitting and wrong for a system a school depends
 * on week after week — for that, deploy it properly (see DEPLOY.md).
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const process = require('node:process');

const LINE = '='.repeat(66);

function resolvePort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--port' && args[i] !== '-p') continue;
    const value = Number(args[i + 1]);
    if (Number.isInteger(value) && value > 0 && value < 65536) return value;
  }
  return Number(process.env.PORT) || 3000;
}

const PORT = resolvePort();

/** Is cloudflared installed and runnable? */
function haveCloudflared() {
  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', shell: true });
  return probe.status === 0;
}

function explainMissingCloudflared() {
  console.error(`\n${LINE}`);
  console.error('  cloudflared is not installed');
  console.error(LINE);
  console.error('\n  It is a single free executable from Cloudflare that relays traffic');
  console.error('  to this machine. Install it, then run this command again.\n');
  if (process.platform === 'win32') {
    console.error('    winget install --id Cloudflare.cloudflared');
    console.error('  or download cloudflared-windows-amd64.exe from');
    console.error('    https://github.com/cloudflare/cloudflared/releases/latest');
    console.error('  and put it somewhere on your PATH.\n');
  } else if (process.platform === 'darwin') {
    console.error('    brew install cloudflared\n');
  } else {
    console.error('    See https://github.com/cloudflare/cloudflared/releases/latest\n');
  }
  console.error('  Prefer not to install anything? Deploy to a host instead - DEPLOY.md');
  console.error('  walks through it, and gives you an address that does not change.\n');
}

/**
 * The admin password.
 *
 * Internet mode refuses to start without a strong one, so rather than fail with
 * a lecture, generate a good one and show it. Printing it here is safe in a way
 * it would not be on a hosting platform: this is the operator's own terminal,
 * not a log file other people can read.
 */
function resolveAdminPassword() {
  const existing = process.env.ADMIN_PASSWORD;
  if (existing && existing.trim().length >= 12) return { value: existing, generated: false };
  return { value: crypto.randomBytes(12).toString('base64url'), generated: true };
}

function main() {
  if (!haveCloudflared()) {
    explainMissingCloudflared();
    process.exit(1);
  }

  const admin = resolveAdminPassword();
  let server = null;
  let announced = false;

  console.log(`\n${LINE}`);
  console.log('  Opening a public address for this exam server...');
  console.log(LINE);
  console.log('  Keep this window open. Closing it takes the exam offline.\n');

  const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  /**
   * cloudflared prints the assigned hostname once, inside a banner, and it goes
   * to stderr. Both streams are scanned rather than assuming which one, because
   * that has changed between releases.
   */
  const watch = (chunk) => {
    const text = String(chunk);
    const match = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i.exec(text);
    if (!match || announced) return;
    announced = true;
    startServer(match[0]);
  };

  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);

  function startServer(publicUrl) {
    console.log(`${LINE}`);
    console.log('  PUBLIC ADDRESS - students open this from anywhere');
    console.log(LINE);
    console.log(`\n  ${publicUrl}\n`);
    console.log(`  Admin console : ${publicUrl}/admin`);
    console.log(`  Admin password: ${admin.value}`);
    if (admin.generated) {
      console.log('  (generated for this session - set ADMIN_PASSWORD to fix it)');
    }
    console.log(`\n${LINE}`);
    console.log('  Before students join:');
    console.log('   1. Open the admin console and set an ACCESS CODE on the quiz.');
    console.log('      This address is public - the code is what keeps strangers out.');
    console.log('   2. Activate the quiz.');
    console.log('   3. Read the address and the code out, or share the QR code from');
    console.log('      the Join Info tab.');
    console.log(`${LINE}\n`);

    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(PORT),
        PUBLIC_URL: publicUrl,
        ADMIN_PASSWORD: admin.value,
        // The tunnel terminates TLS at Cloudflare and forwards plain http to
        // localhost, so redirecting to https here would loop forever.
        FORCE_HTTPS: '0',
      },
    });

    server.on('exit', (code) => {
      console.log(`\n  Exam server stopped (exit ${code}). Closing the tunnel.`);
      tunnel.kill();
      process.exit(code || 0);
    });
  }

  tunnel.on('exit', (code) => {
    if (!announced) {
      console.error(`\n  cloudflared exited (code ${code}) before giving out an address.`);
      console.error('  Check that this machine can reach the internet, then try again.\n');
    } else {
      console.error('\n  The tunnel closed. Students can no longer reach the exam.');
      console.error('  Their answers are safe in the database - restart to continue.\n');
    }
    if (server) server.kill();
    process.exit(code || 1);
  });

  const stop = () => {
    if (server) server.kill();
    tunnel.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
