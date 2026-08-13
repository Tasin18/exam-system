'use strict';

/**
 * Shows or sets the stored admin console password.
 *
 *   npm run password                 show the current password
 *   npm run password -- exam2026     set it to "exam2026"
 *
 * Restart the server after changing it.
 */

// Read the stored value directly: requiring admin-auth would let a stray
// ADMIN_PASSWORD in this shell mask what is actually saved.
delete process.env.ADMIN_PASSWORD;

const { q } = require('../src/db');
const adminAuth = require('../src/admin-auth');

const next = process.argv.slice(2).join(' ').trim();

if (!next) {
  const stored = q.getSetting.get('admin_password');
  if (stored && stored.value) {
    console.log(`\n  Current admin password: ${stored.value}\n`);
    console.log('  Change it with: npm run password -- <new-password>\n');
  } else {
    console.log('\n  No password saved yet. One is generated the first time the '
      + 'server starts.\n');
  }
  process.exit(0);
}

try {
  const value = adminAuth.setStoredPassword(next);
  console.log(`\n  Admin password set to: ${value}`);
  console.log('  Restart the server for it to take effect.\n');
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
