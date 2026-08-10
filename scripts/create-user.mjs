// Creates a user account. Passwords must be hashed by the same code the Worker
// verifies with, so this imports src/auth.js rather than reimplementing PBKDF2.
//
//   node scripts/create-user.mjs <email> <name> <password> [--admin] [--local]
//
// Prints the wrangler command to run, or runs it directly if wrangler is on PATH.
import { hashPassword } from '../src/auth.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [email, name, password] = args.filter((a) => !a.startsWith('--'));

if (!email || !name || !password) {
  console.error('usage: node scripts/create-user.mjs <email> <name> <password> [--admin] [--local]');
  process.exit(1);
}

const hash = await hashPassword(password);
const sql = `INSERT INTO users (email, name, password_hash, is_admin, created_at) ` +
  `VALUES ('${email.toLowerCase().replace(/'/g, "''")}', ` +
  `'${name.replace(/'/g, "''")}', '${hash}', ${flags.has('--admin') ? 1 : 0}, ` +
  `'${new Date().toISOString()}')`;

// Passed as a file, not --command: with shell:true the shell would split the
// statement on spaces and wrangler would see a dozen unknown arguments.
const target = flags.has('--local') ? '--local' : '--remote';
const file = new URL('./.create-user.sql', import.meta.url);
writeFileSync(file, sql + ';\n');
console.log(`Creating ${email} on ${target.slice(2)}…`);
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'htmx-survey', target,
    '--file', fileURLToPath(file)], { stdio: 'inherit', shell: true });
} finally {
  unlinkSync(file);
}
