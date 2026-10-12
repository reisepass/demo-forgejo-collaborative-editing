#!/usr/bin/env node
// A scripted "agent": its own clone, real git commands, no knowledge of pads or the bridge.
// Every round makes one edit carrying a unique marker, commits and pushes; a rejected push is
// answered with `git pull --rebase` and another push; a rebase conflict with abort, reset to
// origin/main and the same edit made again. Prints one JSON line per round.
//
//   agent.js <clone dir> <name: a|b> <rounds> <minMs> <maxMs> <hint file> [seed]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dir, name, roundsArg, minArg, maxArg, hintFile, seedArg] = process.argv.slice(2);
const rounds = Number(roundsArg);
const minMs = Number(minArg);
const maxMs = Number(maxArg);
const FILE = process.env.AGENT_SESSION_FILE || 'docs/x.md';
const OVERLAP_SHARE = Number(process.env.AGENT_OVERLAP_SHARE ?? 0.15);
const OTHER_SHARE = Number(process.env.AGENT_OTHER_SHARE ?? 0.3);

// small deterministic generator, so a run can be repeated with the same choices
let seed = Number(seedArg || 1) * 2654435761 % 4294967296;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
// commit messages: nothing but who and which round
const slow = [];
function git(args, { allowFail = false } = {}) {
  const t0 = Date.now();
  try {
    return { code: 0, out: execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    if (allowFail) return { code: e.status ?? 1, out: String(e.stdout || ''), err: String(e.stderr || '') };
    throw new Error(`git ${args.join(' ')}: ${e.stderr || e.message}`);
  } finally {
    if (Date.now() - t0 > 2000) slow.push({ cmd: args[0], ms: Date.now() - t0, at: new Date(t0).toISOString() });
  }
}
const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');
const write = (f, t) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), t); };

// each edit is a function of the file's current text, so it can be made again on a newer version
function appendToLine(label, marker) {
  return (text) => {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith(label));
    if (i === -1) return null;
    lines[i] += ` ${marker}`;
    return lines.join('\n');
  };
}
function insertAfter(label, line) {
  return (text) => {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith(label));
    if (i === -1) return null;
    lines.splice(i + 1, 0, line);
    return lines.join('\n');
  };
}

function plan(round, marker) {
  const r = rnd();
  const own = `${name}-line ${String(Math.floor(rnd() * 12)).padStart(2, '0')}`;
  if (r < OVERLAP_SHARE) return { kind: 'overlap', file: FILE };
  if (r < OVERLAP_SHARE + OTHER_SHARE) {
    const file = rnd() < 0.8 ? `docs/agent-${name}.md` : 'docs/other.md';
    return { kind: 'other', file, edit: (text) => `${text}${name} round ${round} ${marker}\n` };
  }
  if (rnd() < 0.5) return { kind: 'own-append', file: FILE, edit: appendToLine(own, marker) };
  return { kind: 'own-insert', file: FILE, edit: insertAfter(own, `${name}-extra ${round} ${marker}`) };
}

// waits until the human starts on another line, so the edit really overlaps unflushed text
async function overlapEdit(marker) {
  const before = existsSync(hintFile) ? readFileSync(hintFile, 'utf8') : '';
  const t0 = Date.now();
  let hint = before;
  while (Date.now() - t0 < 8000) {
    hint = existsSync(hintFile) ? readFileSync(hintFile, 'utf8') : '';
    if (hint && hint !== before) break;
    await sleep(25);
  }
  const label = (hint || before).split('\n')[0] || 'h-line 00';
  // sometimes while the person is still typing on that line, sometimes after they stopped but
  // before the bridge has committed it
  await sleep(200 + Math.floor(rnd() * 2300));
  return { label, edit: appendToLine(label, marker) };
}

for (let round = 1; round <= rounds; round++) {
  await sleep(minMs + Math.floor(rnd() * (maxMs - minMs)));
  const marker = `[A${name}-${String(round).padStart(4, '0')}]`;
  const p = plan(round, marker);
  let target;
  if (p.kind === 'overlap') { const o = await overlapEdit(marker); p.edit = o.edit; target = o.label; }
  const rec = { agent: name, round, marker, kind: p.kind, file: p.file, target, rejected: 0, redone: 0, pullFailed: 0 };
  const startedAt = Date.now();
  git(['pull', '--quiet', '--rebase', 'origin', 'main']);
  const make = () => {
    const next = p.edit(read(p.file));
    if (next === null) throw new Error(`${marker}: nothing to edit in ${p.file} (${target})`);
    write(p.file, next);
    git(['add', '--', p.file]);
    git(['commit', '--quiet', '-m', `Agent ${name} round ${round}`]);
  };
  make();
  for (let attempt = 0; ; attempt++) {
    if (attempt > 30) throw new Error(`${marker}: push still rejected after 30 tries`);
    rec.pushStartedAt = Date.now();
    const push = git(['push', '--quiet', 'origin', 'HEAD:main'], { allowFail: true });
    rec.pushedAt = Date.now();
    if (push.code === 0) break;
    rec.rejected += 1;
    if (/bridge:/.test(push.err)) rec.demandRejected = (rec.demandRejected || 0) + 1;
    const pull = git(['pull', '--quiet', '--rebase', 'origin', 'main'], { allowFail: true });
    if (pull.code !== 0) {
      // the same lines changed on main: start over from main and make the edit again
      rec.redone += 1;
      git(['rebase', '--abort'], { allowFail: true });
      git(['fetch', '--quiet', 'origin', 'main']);
      git(['reset', '--quiet', '--hard', 'origin/main']);
      make();
    }
  }
  rec.commit = git(['rev-parse', 'HEAD']).out.trim();
  rec.startedAt = startedAt;
  if (slow.length) rec.slowGit = slow.splice(0);
  process.stdout.write(JSON.stringify(rec) + '\n');
}
