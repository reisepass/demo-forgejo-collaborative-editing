#!/usr/bin/env node
// Measures how long this machine takes to start a trivial process and a trivial git command,
// four times a second. Prints one JSON line for every start that took longer than 500 ms and a
// summary line on SIGTERM. The soak uses it to tell machine stalls from bridge delays.
import { execFileSync } from 'node:child_process';

const slow = [];
let n = 0;
let max = { true: 0, git: 0 };
const timer = setInterval(() => {
  for (const [name, cmd, args] of [['true', '/usr/bin/true', []], ['git', 'git', ['--version']]]) {
    const t0 = Date.now();
    try { execFileSync(cmd, args, { stdio: 'ignore' }); } catch { /* counted by its duration */ }
    const ms = Date.now() - t0;
    n += 1;
    if (ms > max[name]) max[name] = ms;
    if (ms > 500) { const rec = { probe: name, at: t0, ms }; slow.push(rec); process.stdout.write(JSON.stringify(rec) + '\n'); }
  }
}, 250);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.stdout.write(JSON.stringify({ summary: true, samples: n, max, slow: slow.length }) + '\n');
  process.exit(0);
});
