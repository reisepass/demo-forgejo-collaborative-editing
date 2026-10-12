// Stops the stack the tests started (E2E_KEEP=1 leaves it running for a look around).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default function globalTeardown() {
  if (process.env.E2E_KEEP) return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('sh', [path.join(root, 'scripts', 'down.sh')], { stdio: 'inherit', env: process.env });
}
