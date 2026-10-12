// Starts the stack for the tests with scripts/up.sh, in a folder of its own (a new one per run
// unless FORGEJO_LIVE_HOME names one). Short typing pauses so the tests do not wait for the
// defaults.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_ENV = { LIVE_DEBOUNCE_MS: '1500', LIVE_MAX_WAIT_MS: '20000', LIVE_HOLD_MS: '400', LIVE_POLL_MS: '15000', LIVE_EMPTY_MS: '4000' };

export default function globalSetup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!process.env.FORGEJO_LIVE_HOME) {
    const scratch = process.env.E2E_SCRATCH || path.join(os.tmpdir(), 'forgejo-live-e2e');
    process.env.FORGEJO_LIVE_HOME = path.join(scratch, `run-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`);
    process.env.E2E_FRESH = '1';
  }
  mkdirSync(process.env.FORGEJO_LIVE_HOME, { recursive: true });
  for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] ??= v;
  execFileSync('sh', [path.join(root, 'scripts', 'up.sh'), '--quiet'], { stdio: 'inherit', env: process.env });
  process.stderr.write(`stack for the tests: ${process.env.FORGEJO_LIVE_HOME}\n`);
}
