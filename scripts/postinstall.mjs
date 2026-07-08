/**
 * Best-effort Prisma client generation after `npm install`.
 *
 * This NEVER fails the install:
 *   - Local SQLite mode (the classroom default) does not use Prisma at all,
 *     so a failure here is harmless.
 *   - Postgres/Supabase users get their client auto-generated when possible;
 *     if it fails (e.g. offline, restricted network), they can simply run
 *     `npm run prisma:generate` later.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['prisma', 'generate'], {
  stdio: 'inherit',
  // On Windows, npx resolves to npx.cmd which requires a shell.
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.warn(
    '[postinstall] "prisma generate" was skipped or failed — this is OK for local SQLite mode. ' +
      'If you use Postgres/Supabase, run "npm run prisma:generate" manually.'
  );
}

// Always exit 0 so a failed generate can never block installation.
process.exit(0);
