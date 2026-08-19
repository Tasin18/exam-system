'use strict';

/**
 * Shows or sets the stored admin console password.
 *
 *   npm run password                 show the current password
 *   npm run password -- exam2026     set it to "exam2026"
 *
 * Restart the server after changing it.
 */

// Read the stored value directly: requiring the auth module would let a stray
// ADMIN_PASSWORD in this shell mask what is actually saved.
delete process.env.ADMIN_PASSWORD;

// PUBLIC_URL is likewise cleared before the auth module loads. It would otherwise put
// that module in internet mode, where a missing ADMIN_PASSWORD is a fatal
// misconfiguration - and this tool would exit with a startup lecture instead of
// answering the question that was asked.
const WAS_PUBLIC = !!String(process.env.PUBLIC_URL || '').trim();
delete process.env.PUBLIC_URL;

/** Warns that the stored password is not the one a public deployment uses. */
function publicModeNote() {
  if (!WAS_PUBLIC) return;
  console.log('  NOTE: PUBLIC_URL is set in this shell, so this deployment is meant');
  console.log('  to be reachable from the internet. There the password comes from');
  console.log('  the ADMIN_PASSWORD environment variable and the stored one below');
  console.log('  is ignored entirely. Change it where you set your environment.');
  console.log('');
}

const { q } = require('../src/db');
const auth = require('../src/auth');

const next = process.argv.slice(2).join(' ').trim();

if (!next) {
  const stored = q.getSetting.get('admin_password');
  if (stored && stored.value) {
    console.log(`\n  Current admin password: ${stored.value}\n`);
    publicModeNote();
    console.log('  Change it with: npm run password -- <new-password>\n');
  } else {
    console.log('\n  No password saved yet. One is generated the first time the '
      + 'server starts.\n');
  }
  process.exit(0);
}

try {
  const value = auth.setStoredPassword(next);
  console.log(`\n  Admin password set to: ${value}`);
  console.log('  Restart the server for it to take effect.\n');
  publicModeNote();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
