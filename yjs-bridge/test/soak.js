#!/usr/bin/env node
// The decisive soak: one person typing at human speed in the editor (headless Chromium, real
// keyboard events), two agent processes with their own clones committing and pushing with real
// git, the service in between. Every edit carries a unique marker; at the end every marker is
// accounted for.
//
// Settings (environment):
//   SOAK_ROUNDS      rounds per agent (default 100, so 200 in total)
//   SOAK_MIN_MS / SOAK_MAX_MS   pause before each agent round (default 5000 / 20000)
//   SOAK_DEBOUNCE_MS (1000), SOAK_MAX_WAIT_MS (8000)
//   SOAK_HOLD_MS     hold of a clashing fold while the person types (default 700; 0 = off)
//   SOAK_REMOTE      SSH URL of a scratch repository on a real host: no hooks, polling (SOAK_POLL_MS)
//   SOAK_AGENT_LIMIT_MS (2000), SOAK_HUMAN_SLACK_MS (2000)   the two latency limits
//   AGENT_OVERLAP_SHARE (0.15), AGENT_OTHER_SHARE (0.3)   see agent.js
// Exit code 1 when a pass criterion is violated. The full result is written to <world>/soak-result.json.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { signIn } from './human.js';
import { GIT_ENV, git, makeWorld, sleep, until } from './helpers.js';

const ROUNDS = Number(process.env.SOAK_ROUNDS || 100);
const MIN_MS = Number(process.env.SOAK_MIN_MS || 5000);
const MAX_MS = Number(process.env.SOAK_MAX_MS || 20000);
const DEBOUNCE_MS = Number(process.env.SOAK_DEBOUNCE_MS || 1000);
const MAX_WAIT_MS = Number(process.env.SOAK_MAX_WAIT_MS || 8000);
const HOLD_MS = Number(process.env.SOAK_HOLD_MS ?? 700);
const REMOTE = process.env.SOAK_REMOTE || null;
const POLL_MS = Number(process.env.SOAK_POLL_MS || (REMOTE ? 2500 : 5000));
const AGENT_LIMIT_MS = Number(process.env.SOAK_AGENT_LIMIT_MS || 2000);
const HUMAN_SLACK_MS = Number(process.env.SOAK_HUMAN_SLACK_MS || 2000);
const AGENT_JS = fileURLToPath(new URL('./agent.js', import.meta.url));
const FILE = 'docs/x.md';
const MARKER = /\[(?:A[ab]-\d{4}|H\d{4})\]/g;

const section = (p) => Array.from({ length: 12 }, (_, i) => `${p}-line ${String(i).padStart(2, '0')}`).join('\n');
const DOC = `# Soak document\n\n## Human section\n${section('h')}\n\n## Agent a section\n${section('a')}\n\n## Agent b section\n${section('b')}\n\n## End\n`;
const WORDS = ['river', 'copper', 'window', 'seven', 'garden', 'paper', 'quiet', 'lantern', 'meadow', 'signal', 'harbor', 'thread'];

const rnd = Math.random;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a));
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = (xs) => ({ n: xs.length, min: xs.length ? Math.min(...xs) : null, median: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null });
const count = (text, needle) => text.split(needle).length - 1;

const t00 = Date.now();
const w = await makeWorld(REMOTE ? 'soak-remote' : HOLD_MS ? 'soak-hold' : 'soak', { files: { [FILE]: DOC, 'docs/other.md': 'shared other file\n', 'docs/agent-a.md': 'agent a file\n', 'docs/agent-b.md': 'agent b file\n' }, remote: REMOTE });
const hintFile = path.join(w.dir, 'human-line.txt');
console.log(`world: ${w.dir}`);
console.log(`settings: ${ROUNDS} rounds per agent (${2 * ROUNDS} total), agent pause ${MIN_MS}-${MAX_MS} ms, debounce ${DEBOUNCE_MS} ms, max-wait ${MAX_WAIT_MS} ms, hold of clashing folds ${HOLD_MS || 'off'}`);
const b = await w.startBridge({ debounceMs: DEBOUNCE_MS, maxWaitMs: MAX_WAIT_MS, holdMs: HOLD_MS, pollMs: POLL_MS, hooks: !REMOTE, env: { BRIDGE_LOG_LEVEL: process.env.BRIDGE_LOG_LEVEL || 'debug', LIVE_BRIDGE_HOOK_TRACE: path.join(w.dir, 'hook-trace.log') } });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
const token = await signIn(b.origin, 'Ada Human', 'ada@humans.test');
await context.addInitScript(([t, u]) => { localStorage.setItem('lb.token', t); localStorage.setItem('lb.user', u); }, [token, JSON.stringify({ name: 'Ada Human', email: 'ada@humans.test' })]);
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`${b.origin}/r/${w.slug}/edit/${FILE}`);
await page.waitForFunction(() => window.__lb && window.__lb.client && window.__lb.client.synced);
// a sentinel a reload would wipe, and the first moment each agent marker is in the editor (after
// the frame in which it was drawn), on the page's own clock
await page.evaluate(() => {
  window.__neverReloaded = true;
  window.__seen = {};
  const scan = () => {
    const now = Date.now();
    for (const m of window.__lb.view.state.doc.toString().matchAll(/\[A[ab]-\d{4}\]/g)) if (!(m[0] in window.__seen)) window.__seen[m[0]] = now;
  };
  window.__lb.client.doc.getText('text').observe(() => requestAnimationFrame(scan));
  scan();
});
const ui = {
  value: () => page.evaluate(() => window.__lb.view.state.doc.toString()),
  async typeAtEndOfLine(label, text, delay) {
    await page.evaluate((p) => {
      const v = window.__lb.view;
      const doc = v.state.doc.toString();
      const at = doc.indexOf(p);
      const nl = doc.indexOf('\n', at);
      v.focus();
      v.dispatch({ selection: { anchor: nl === -1 ? doc.length : nl }, scrollIntoView: true });
    }, label);
    await page.keyboard.type(text, { delay });
  },
};

// ---- how responsive is the machine itself (process starts), independent of the bridge
const probeRecs = [];
const probe = spawn(process.execPath, [fileURLToPath(new URL('./spawn-probe.js', import.meta.url))], { stdio: ['ignore', 'pipe', 'ignore'] });
let probeBuf = '';
probe.stdout.on('data', (d) => {
  probeBuf += d;
  for (let nl; (nl = probeBuf.indexOf('\n')) !== -1; probeBuf = probeBuf.slice(nl + 1)) probeRecs.push(JSON.parse(probeBuf.slice(0, nl)));
});
const probeDone = new Promise((res) => probe.on('close', res));

// ---- agents
const agentRecs = [];
const agents = [];
for (const name of ['a', 'b']) {
  const clone = await w.clone(name);
  const child = spawn(process.execPath, [AGENT_JS, clone.dir, name, String(ROUNDS), String(MIN_MS), String(MAX_MS), hintFile, String(name === 'a' ? 11 : 23)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_SSH_COMMAND: GIT_ENV.GIT_SSH_COMMAND } });
  let buf = '';
  let err = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf('\n')) !== -1; buf = buf.slice(nl + 1)) agentRecs.push(JSON.parse(buf.slice(0, nl)));
  });
  child.stderr.on('data', (d) => { err += d; });
  agents.push(new Promise((res) => child.on('close', (code) => res({ name, code, err }))));
}
let agentsDone = false;
const agentExits = Promise.all(agents).then((x) => { agentsDone = true; return x; });

// ---- the human
const edits = [];
let n = 0;
while (!agentsDone) {
  n += 1;
  const marker = `[H${String(n).padStart(4, '0')}]`;
  const label = `h-line ${String(between(0, 12)).padStart(2, '0')}`;
  const r = rnd();
  let kind, text;
  if (r < 0.5) { kind = 'append'; text = ` ${pick(WORDS)} ${marker}`; }
  else if (r < 0.75) { kind = 'sentence'; text = ` the ${pick(WORDS)} by the ${pick(WORDS)} ${marker} was ${pick(WORDS)} and ${pick(WORDS)}`; }
  else { kind = 'newline'; text = `\nh-note ${marker} ${pick(WORDS)}`; }
  writeFileSync(hintFile, `${label}\n${n}\n`);
  const start = Date.now();
  await ui.typeAtEndOfLine(label, text, between(35, 90));
  edits.push({ marker, label, kind, text, start, end: Date.now() });
  await sleep(rnd() < 0.7 ? between(DEBOUNCE_MS + 500, DEBOUNCE_MS + 2500) : between(150, 600));
  if (n % 25 === 0) console.log(`  ${Math.round((Date.now() - t00) / 1000)} s: ${n} human edits, ${agentRecs.length}/${2 * ROUNDS} agent rounds, ${b.count('flush')} flushes, ${b.count('conflict')} conflicts`);
}
const exits = await agentExits;

// ---- quiescence
const violations = [];
let final = {};
try {
  await until(async () => {
    const s = (await b.status()).sessions[0];
    final = { browser: await ui.value(), pad: await b.fresh(FILE), main: await w.main(FILE), dirty: s?.dirty, behind: s?.behind };
    return final.browser === final.main && final.pad === final.main && final.dirty === false && final.behind === false;
  }, 'quiescence', REMOTE ? 90000 : 30000, REMOTE ? 1000 : 200);
  await sleep(3000);
  const again = { browser: await ui.value(), main: await w.main(FILE) };
  if (again.browser !== final.browser || again.main !== final.main) violations.push({ what: 'not-quiescent', detail: 'editor or main still moved 3 s after they agreed' });
} catch {
  violations.push({ what: 'editor-differs-from-main', detail: { browserEqualsMain: final.browser === final.main, roomEqualsMain: final.pad === final.main, dirty: final.dirty, behind: final.behind } });
}
probe.kill('SIGTERM');
await probeDone;
const stalls = probeRecs.filter((p) => !p.summary);
const duringStall = (from, to) => stalls.some((p) => p.at <= to && p.at + p.ms >= from);
const seen = await page.evaluate(() => window.__seen);
const reloaded = !(await page.evaluate(() => window.__neverReloaded === true));
const banners = await page.evaluate(() => [...document.querySelectorAll('[data-testid="conflict-branch"]')].map((e) => e.textContent));
const st = await b.status();

// ---- accounting
for (const e of exits) if (e.code !== 0) violations.push({ what: 'agent-failed', detail: { agent: e.name, code: e.code, stderr: e.err.slice(-2000) } });
if (agentRecs.length !== 2 * ROUNDS) violations.push({ what: 'agent-rounds-missing', detail: `${agentRecs.length} of ${2 * ROUNDS} rounds reported` });
if (reloaded) violations.push({ what: 'browser-reloaded' });
if (pageErrors.length) violations.push({ what: 'browser-page-errors', detail: pageErrors.slice(0, 5) });

await w.tip();
const files = (await git(w.bare, ['ls-tree', '-r', '--name-only', 'main'])).split('\n').filter(Boolean);
let mainAll = '';
for (const f of files) mainAll += await w.main(f);
const branches = await w.branches();
const branchText = {};
for (const br of branches) branchText[br] = await w.main(FILE, br);

const expected = new Set([...agentRecs.map((r) => r.marker), ...edits.map((e) => e.marker)]);
const onMain = {};
for (const m of mainAll.match(MARKER) || []) onMain[m] = (onMain[m] || 0) + 1;
for (const [m, c] of Object.entries(onMain)) {
  if (c > 1) violations.push({ what: 'duplicated-marker', marker: m, detail: `${c} times on main` });
  if (!expected.has(m)) violations.push({ what: 'unknown-marker', marker: m });
}
const core = (m) => m.slice(1, -1);
const anywhere = (needle) => ({ main: count(mainAll, needle), branches: branches.filter((br) => branchText[br].includes(needle)) });

// A marker that is not intact where it should be is a violation of the pass criterion. To tell
// lost text from text that a conflict fold interleaved with keystrokes still on their way, the
// marker's inner token and then its pieces are looked up as well.
let agentBroken = 0;
for (const r of agentRecs) {
  if (onMain[r.marker]) continue;
  const c = anywhere(core(r.marker));
  if (c.main === 1) { agentBroken += 1; violations.push({ what: 'agent-marker-interleaved-with-typing', marker: r.marker, detail: { line: mainAll.split('\n').find((l) => l.includes(core(r.marker))), target: r.target } }); }
  else violations.push({ what: 'lost-agent-marker', marker: r.marker, detail: r });
}

let humanOnMain = 0;
let humanInBranchOnly = 0;
let humanInBoth = 0;
const broken = [];
for (const e of edits) {
  const inBranches = branches.filter((br) => branchText[br].includes(e.marker));
  if (onMain[e.marker]) {
    humanOnMain += 1;
    if (inBranches.length) humanInBoth += 1;
    continue;
  }
  if (inBranches.length === 1) { humanInBranchOnly += 1; e.conflictBranch = inBranches[0]; continue; }
  if (inBranches.length > 1) { violations.push({ what: 'human-marker-in-several-conflict-branches', marker: e.marker, detail: inBranches }); continue; }
  // intact nowhere: find the pieces. The inner token H0000 is typed between brackets that the
  // editor closes by itself, so a fold in mid-typing can leave "[]" behind and the token elsewhere.
  const token = core(e.marker);
  let found = null;
  for (let k = token.length; k >= 0 && !found; k--) {
    const head = token.slice(0, k);
    const tail = token.slice(k);
    const inBranch = !head || branches.find((x) => branchText[x].split('\n').some((l) => l.startsWith(e.label) && l.includes(head)));
    const lineOnMain = !tail || (final.main || '').split('\n').find((l) => l.startsWith(e.label) && l.includes(tail));
    if (inBranch && lineOnMain && (head.length >= 2 || tail.length >= 2)) found = { head, headIn: head ? inBranch : null, tail, mainLine: tail ? lineOnMain : null };
  }
  if (found) { broken.push({ marker: e.marker, ...found }); violations.push({ what: 'human-marker-broken-by-conflict-mid-typing', marker: e.marker, detail: { ...found, label: e.label, kind: e.kind } }); }
  else violations.push({ what: 'lost-human-marker', marker: e.marker, detail: { label: e.label, kind: e.kind, text: e.text } });
}
const split = broken;

// agent commit -> visible in the browser (session file only)
const fromReturn = [];
const fromStart = [];
const fromReturnOverlap = [];
const fromReturnOther = [];
const heldCommits = new Set(b.of('fold-held').map((e) => e.commit));
const fromReturnHeld = [];
const fromReturnNotHeld = [];
for (const r of agentRecs.filter((x) => x.file === FILE)) {
  if (!(r.marker in seen)) { violations.push({ what: 'agent-marker-never-seen-in-browser', marker: r.marker }); continue; }
  if (r.kind === 'overlap') fromReturnOverlap.push(seen[r.marker] - r.pushedAt); else fromReturnOther.push(seen[r.marker] - r.pushedAt);
  (heldCommits.has(r.commit) ? fromReturnHeld : fromReturnNotHeld).push(seen[r.marker] - r.pushedAt);
  fromReturn.push(seen[r.marker] - r.pushedAt);
  fromStart.push(seen[r.marker] - r.pushStartedAt);
  if (seen[r.marker] - r.pushedAt >= AGENT_LIMIT_MS) violations.push({ what: 'agent-commit-visible-late', marker: r.marker, kind: r.kind, heldForTypingPause: heldCommits.has(r.commit), detail: `${seen[r.marker] - r.pushedAt} ms after the push returned`, machineStallInThatWindow: duringStall(r.pushedAt, seen[r.marker]) });
}

// human text -> main, measured from the end of the typing burst the marker belongs to
const flushes = b.of('flush');
const landed = {};
for (const f of flushes) {
  const text = await w.main(FILE, f.commit);
  for (const m of text.match(MARKER) || []) if (m[1] === 'H' && !(m in landed)) landed[m] = Date.parse(f.at);
}
const humanMs = [];
const fromTyped = [];
for (let i = 0; i < edits.length; i++) {
  const e = edits[i];
  if (!(e.marker in landed)) continue;
  // the burst ends at the first pause of at least the debounce
  let j = i;
  while (j + 1 < edits.length && edits[j + 1].start - edits[j].end < DEBOUNCE_MS) j += 1;
  const burstEnd = edits[j].end;
  const ms = landed[e.marker] - burstEnd;
  e.landMs = ms;
  fromTyped.push(landed[e.marker] - e.end);
  humanMs.push(Math.max(0, ms));
  if (ms > DEBOUNCE_MS + HUMAN_SLACK_MS) violations.push({ what: 'human-text-late-on-main', marker: e.marker, detail: `${ms} ms after the typing pause began (limit ${DEBOUNCE_MS + HUMAN_SLACK_MS} ms)`, machineStallInThatWindow: duringStall(burstEnd, landed[e.marker]) });
}

// the host's own record of every update of main
let ffChecked = 0;
try { ffChecked = await w.assertMainOnlyMovedForward(); } catch (e) { violations.push({ what: 'main-moved-backwards', detail: e.message }); }
const authors = {};
for (const a of await w.logSince('%an')) authors[a] = (authors[a] || 0) + 1;
const folds = b.of('fold');

const result = {
  settings: { roundsTotal: 2 * ROUNDS, agentPauseMs: [MIN_MS, MAX_MS], debounceMs: DEBOUNCE_MS, maxWaitMs: MAX_WAIT_MS, holdMs: HOLD_MS, remote: REMOTE, pollMs: POLL_MS },
  wallSeconds: Math.round((Date.now() - t00) / 1000),
  agentRounds: { total: agentRecs.length, bySessionFile: agentRecs.filter((r) => r.file === FILE).length, otherFiles: agentRecs.filter((r) => r.file !== FILE).length, deliberateOverlaps: agentRecs.filter((r) => r.kind === 'overlap').length },
  agentPushesRejected: agentRecs.reduce((s, r) => s + r.rejected, 0),
  agentEditsRedoneAfterRebaseConflict: agentRecs.reduce((s, r) => s + r.redone, 0),
  agentGitCommandsOver2s: agentRecs.flatMap((r) => (r.slowGit || []).map((x) => ({ marker: r.marker, ...x }))),
  humanEdits: edits.length,
  humanMarkers: { onMain: humanOnMain, onlyInOneConflictBranch: humanInBranchOnly, onMainAndAlsoInAConflictBranch: humanInBoth, brokenByConflictMidTyping: split.length },
  agentMarkersInterleavedWithTyping: agentBroken,
  bridge: {
    flushes: flushes.length,
    flushReasons: flushes.reduce((m, f) => { m[f.reason] = (m[f.reason] || 0) + 1; return m; }, {}),
    folds: folds.length,
    foldsThatChangedTheText: folds.filter((f) => f.changed).length,
    cleanMergesIntoUnflushedText: folds.filter((f) => f.dirty && !f.conflicts).length,
    foldsMergedWordByWord: folds.filter((f) => f.wordMerges).length,
    conflicts: b.count('conflict'),
    foldsHeldForATypingPause: b.count('fold-held'),
    conflictBranches: branches.length,
    bridgePushesRejected: b.count('push-rejected'),
    errors: b.of('error'),
  },
  commitsOnMainByAuthor: authors,
  mainUpdatesCheckedFastForward: ffChecked,
  latencyMs: {
    agentPushReturnedToVisibleInBrowser: stats(fromReturn),
    agentPushStartedToVisibleInBrowser: stats(fromStart),
    deliberateOverlapsOnlyPushReturnedToVisible: stats(fromReturnOverlap),
    nonOverlappingOnlyPushReturnedToVisible: stats(fromReturnOther),
    foldsHeldForATypingPauseOnly: stats(fromReturnHeld),
    foldsNotHeldOnly: stats(fromReturnNotHeld),
    humanTypingPauseToOnMain: stats(humanMs),
    humanMarkerTypedToOnMain: stats(fromTyped),
    limitHumanMs: DEBOUNCE_MS + HUMAN_SLACK_MS,
    limitAgentMs: AGENT_LIMIT_MS,
  },
  machine: { processStartProbe: probeRecs.find((p) => p.summary) || null, startsOver500ms: stalls },
  editorEqualsMain: final.browser === final.main && final.pad === final.main,
  conflictBranchesNamedInTheEditor: banners.length,
  conflictBannersNameRealBranches: banners.every((x) => branches.includes(x)),
  conflictsInStatus: st.conflicts.length,
  violations,
};
writeFileSync(path.join(w.dir, 'soak-result.json'), JSON.stringify({ ...result, edits, agentRecs }, null, 1));
console.log(JSON.stringify(result, null, 1));
const byKind = violations.reduce((m, v) => { m[v.what] = (m[v.what] || 0) + 1; return m; }, {});
console.log(`violations by kind: ${JSON.stringify(byKind)}`);
console.log(violations.length ? `SOAK: ${violations.length} VIOLATION(S)` : 'SOAK: PASS, no violations');
await browser.close();
await w.stop();
process.exit(violations.length ? 1 : 0);
