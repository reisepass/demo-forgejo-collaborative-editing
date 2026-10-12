#!/usr/bin/env node
// Stops what up.mjs started, by recorded pid, and nothing else. A pid whose command line no
// longer carries this stack's folder is treated as somebody else's process and left alone.
//
//   node scripts/down.mjs [--only forgejo|service|proxy] [--kill]
import { HOME, PARTS, log, stop } from './lib.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (only && !PARTS.includes(only)) { log.error(`--only takes one of ${PARTS.join(', ')}`); process.exit(2); }
// --kill: no chance to flush (what a crash looks like)
const signal = args.includes('--kill') ? 'SIGKILL' : 'SIGTERM';

for (const part of [...PARTS].reverse()) {
  if (only && only !== part) continue;
  log.info(`${part}: ${await stop(part, { signal })} (${HOME})`);
}
