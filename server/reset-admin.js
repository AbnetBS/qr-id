'use strict';
/**
 * Emergency password reset.
 *
 *   npm run reset-admin -- <username> <new-password>
 *   npm run reset-admin -- --list
 */

const { db } = require('./db');
const { hashPassword, verifyPassword } = require('./auth');

const [cmd, cmd2] = process.argv.slice(2);

if (!cmd || cmd === '--list' || cmd === '-l') {
  const rows = db.prepare('SELECT id, username, full_name, last_login FROM admins').all();
  console.log('Admin accounts:');
  for (const r of rows) {
    console.log(`  #${r.id}  ${r.username}  (${r.full_name || 'no name'})  last login: ${r.last_login || 'never'}`);
  }
  console.log('\nUsage:  npm run reset-admin -- <username> <new-password>');
  console.log('        npm run reset-admin -- <username> --random');
  process.exit(0);
}

if (!cmd2) {
  console.error('Missing new password. Usage: npm run reset-admin -- <username> <new-password>');
  process.exit(1);
}

const username = String(cmd).trim();
const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
if (!admin) {
  console.error(`No admin named "${username}". Run with --list to see accounts.`);
  process.exit(1);
}

const password =
  cmd2 === '--random'
    ? require('node:crypto').randomBytes(9).toString('base64url')
    : String(cmd2);

db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(password), admin.id);
db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(admin.id);

console.log(`Password updated for "${username}". All sessions were signed out.`);
if (cmd2 === '--random') console.log(`New password: ${password}`);
if (cmd2 === 'admin123') console.warn('That password is the public default - change it as soon as you can sign in.');
verifyPassword(password, admin.password_hash); // sanity no-op
