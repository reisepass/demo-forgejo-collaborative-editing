// Tier 7: the service against a repository on GitHub (git over SSH). GitHub cannot call a laptop,
// so main is watched by polling here; the webhook path is exercised with deliveries built and
// signed locally from real pushes (see the webhook test).
//
// Needs BRIDGE_REMOTE=<ssh url of a scratch repository you may write to>. Each test resets the
// test files with an ordinary commit; nothing is ever forced or deleted. What is on the host is
// checked in clones that are not the service's: a mirror refreshed before every look, and a
// brand-new clone at the end of each test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { DOC, git, lineOf, makeWorld, replaceLine, sleep, until } from './helpers.js';
import { signIn } from './human.js';

const REMOTE = process.env.BRIDGE_REMOTE;
if (!REMOTE) throw new Error('set BRIDGE_REMOTE to the SSH URL of a scratch repository');
const POLL_MS = Number(process.env.BRIDGE_POLL_MS || 2500);
const OPTS = { pollMs: POLL_MS, holdMs: 700, debounceMs: 1000 };

const worlds = [];
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => {
  for (const w of worlds) await w.stop();
  await browser?.close();
});

const world = async (name) => { const w = await makeWorld(name, { remote: REMOTE }); worlds.push(w); return w; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const summary = (xs) => `median ${pct(xs, 0.5)} ms, p95 ${pct(xs, 0.95)} ms, min ${Math.min(...xs)} ms, max ${Math.max(...xs)} ms, n=${xs.length}`;

async function settled(w, b, file = 'docs/x.md') {
  let state;
  await until(async () => {
    const s = await b.session(file);
    state = { live: await b.fresh(file), main: await w.main(file), dirty: s?.dirty, behind: s?.behind };
    return state.live === state.main && state.dirty === false && state.behind === false;
  }, 'live text and main to agree', 60000, 300).catch((e) => { assert.equal(state.live, state.main, `live text equals main (${e.message})`); throw e; });
  return state.main;
}

test('a human edit lands on GitHub with the human as author and the bridge as committer', async () => {
  const w = await world('gh-edit');
  const b = await w.startBridge(OPTS);
  assert.equal((await b.status()).kind, 'github');
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const t0 = Date.now();
  await ada.edit(replaceLine(3, 'line 03 typed by a human'));
  const f = await b.waitFor('flush', undefined, 30000);
  console.log(`# edit -> commit accepted by GitHub: ${Date.parse(f.at) - t0} ms (debounce 1000 ms; building the commit and pushing took ${f.ms} ms)`);
  const expected = replaceLine(3, 'line 03 typed by a human')(DOC);
  const fresh = await w.freshClone();
  assert.equal(fresh.tip, f.commit, 'a brand-new clone has the commit as main');
  assert.equal(fresh.text('docs/x.md'), expected);
  const [an, ae, cn, ce, parent, subject] = (await fresh.git(['log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%P%n%s'])).trim().split('\n');
  assert.deepEqual([an, ae], ['Ada Human', 'ada@humans.test']);
  assert.deepEqual([cn, ce], ['live-bridge', 'live-bridge@localhost']);
  assert.equal(subject, 'Live edit docs/x.md: +1 -1 lines');
  assert.equal(parent, w.seed);
  console.log(`# commit on GitHub: ${f.commit}`);
  assert.ok(await w.assertMainOnlyMovedForward() >= 1);
});

test('agent commits: another file leaves the room alone; other lines of the open file appear in the editor and both edits end on GitHub', async () => {
  const w = await world('gh-merge');
  const b = await w.startBridge({ ...OPTS, debounceMs: 4000 });
  const ada = await b.human();
  let updates = 0;
  ada.doc.on('update', () => { updates += 1; });
  const a = await w.clone('a');
  const other = await a.change('docs/other.md', (t) => t + 'more\n');
  await until(async () => (await b.session()).base === other, 'the base to advance', 30000, 200);
  assert.equal(updates, 0, 'the editor saw no change');
  assert.equal(b.count('fold'), 0);
  assert.equal(await w.tip(), other, 'no extra commit');

  await ada.edit(replaceLine(4, 'line 04 human edit'));
  const t0 = Date.now();
  const agentCommit = await a.change('docs/x.md', replaceLine(15, 'line 15 agent edit'));
  const t1 = Date.now();
  await until(() => ada.text().includes('line 15 agent edit'), 'the agent edit in the editor', 30000);
  console.log(`# agent push returned -> in the editor: ${Date.now() - t1} ms (poll every ${POLL_MS} ms); the agent's pull+commit+push took ${t1 - t0} ms`);
  assert.ok(ada.text().includes('line 04 human edit'));
  assert.equal(ada.of('notice').find((n) => n.kind === 'fold').commit, agentCommit);
  const f = await b.waitFor('flush', undefined, 30000);
  const expected = replaceLine(15, 'line 15 agent edit')(replaceLine(4, 'line 04 human edit')(DOC));
  assert.equal(await settled(w, b), expected);
  assert.equal((await w.freshClone()).text('docs/x.md'), expected);
  assert.deepEqual((await w.commitInfo(f.commit)).parents, [agentCommit]);
  assert.deepEqual(await w.branches(), []);
});

test('clashing edits with the hold: main keeps the agent\'s line, the conflict branch is on GitHub', async () => {
  const w = await world('gh-conflict');
  const b = await w.startBridge({ ...OPTS, debounceMs: 20000 });
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const base = ada.room.base;
  const a = await w.clone('a');
  await ada.edit((t) => replaceLine(12, 'line 12 human, no overlap')(replaceLine(7, 'the HUMAN rewrote this line completely')(t)));
  const humanText = ada.text();
  const agentCommit = await a.change('docs/x.md', replaceLine(7, 'line 07 holds other words from the AGENT now'));
  const ev = await b.waitFor('conflict', undefined, 30000);
  const merged = replaceLine(12, 'line 12 human, no overlap')(replaceLine(7, 'line 07 holds other words from the AGENT now')(DOC));
  await until(() => ada.text() === merged, 'the merged text in the editor', 20000);
  assert.equal(ev.pushed, true);
  assert.match(ev.branch, /^conflict\/ada-human\/docs_x\.md-\d{8}T\d{9}Z$/);
  // asked from GitHub directly, then looked at in a brand-new clone of that branch
  const listed = (await git(w.dir, ['ls-remote', REMOTE, `refs/heads/${ev.branch}`])).trim().split(/\s+/)[0];
  assert.equal(listed, ev.commit, 'GitHub has the conflict branch');
  const fresh = await w.freshClone(ev.branch);
  assert.equal(fresh.text('docs/x.md'), humanText, 'it holds the complete text from before the merge');
  assert.equal((await fresh.git(['log', '-1', '--format=%P'])).trim(), base, 'its parent is the room base');
  assert.equal(ev.mainCommit, agentCommit);
  assert.equal(ada.of('conflict')[0].branch, ev.branch, 'the editor was told the branch');
  assert.equal((await b.close('docs/x.md')).status, 200);
  assert.equal((await w.freshClone()).text('docs/x.md'), merged);
  assert.deepEqual(await w.logSince('%an'), ['Ada Human', 'Agent a']);
  console.log(`# conflict branch on GitHub: ${ev.branch} at ${ev.commit}`);
  await w.assertMainOnlyMovedForward();
});

test('a bridge push that is behind GitHub (an agent pushed first) is rejected there and retried after folding', async () => {
  const w = await world('gh-nonff');
  // polling practically off: the bridge only learns that main moved from its own rejected push
  const b = await w.startBridge({ ...OPTS, pollMs: 3600000 });
  const ada = await b.human();
  const a = await w.clone('a');
  const agentCommit = await a.change('docs/x.md', replaceLine(18, 'line 18 agent edit'));
  await ada.edit(replaceLine(2, 'line 02 human edit'));
  const f = await b.waitFor('flush', undefined, 40000);
  assert.equal(b.count('push-rejected'), 1);
  console.log(`# GitHub refused the bridge push: "${b.of('push-rejected')[0].reason}"; landed on attempt ${f.attempt + 1}`);
  assert.deepEqual((await w.commitInfo(f.commit)).parents, [agentCommit]);
  const expected = replaceLine(18, 'line 18 agent edit')(replaceLine(2, 'line 02 human edit')(DOC));
  assert.equal((await w.freshClone()).text('docs/x.md'), expected);
  await until(() => ada.text() === expected, 'the editor');
  await w.assertMainOnlyMovedForward();
});

test('two humans: authorship from who typed; session end by leaving; the next session starts from GitHub', async () => {
  const w = await world('gh-two');
  const b = await w.startBridge({ ...OPTS, emptyMs: 1500 });
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const bob = await b.human('docs/x.md', 'Bob Human', 'bob@humans.test');
  await ada.edit(replaceLine(3, 'line 03 by ada'));
  await bob.edit(replaceLine(14, 'line 14 by bob'));
  const f = await b.waitFor('flush', undefined, 30000);
  const c = await w.commitInfo(f.commit);
  assert.equal(c.ae, 'ada@humans.test');
  assert.equal(c.body, 'Co-authored-by: Bob Human <bob@humans.test>');
  await settled(w, b);
  // both leave right after one more edit by Bob alone
  await bob.edit(replaceLine(6, 'line 06 typed just before leaving'));
  ada.close();
  bob.close();
  const closed = await b.waitFor('session-close', undefined, 40000);
  const expected = replaceLine(6, 'line 06 typed just before leaving')(replaceLine(14, 'line 14 by bob')(replaceLine(3, 'line 03 by ada')(DOC)));
  const fresh = await w.freshClone();
  assert.equal(fresh.text('docs/x.md'), expected);
  assert.equal((await fresh.git(['log', '-1', '--format=%an|%b'])).trim(), 'Bob Human|', 'the last commit is Bob\'s alone');
  const a = await w.clone('a');
  await a.change('docs/x.md', replaceLine(11, 'line 11 agent edit'));
  await sleep(POLL_MS + 1500);
  assert.equal(await b.fresh(), replaceLine(11, 'line 11 agent edit')(expected));
  console.log(`# session closed (${closed.reason}); the next one started from what GitHub had`);
});

test('kill -9 with unflushed text: after the restart the text reaches GitHub', async () => {
  const w = await world('gh-crash');
  const b = await w.startBridge({ ...OPTS, debounceMs: 60000 });
  const ada = await b.human();
  await ada.edit(replaceLine(5, 'line 05 typed before the crash'));
  assert.equal((await b.session()).dirty, true);
  await b.kill('SIGKILL');
  const a = await w.clone('a');
  const agentCommit = await a.change('docs/x.md', replaceLine(17, 'line 17 agent while the service was dead'));
  await ada.edit(replaceLine(6, 'line 06 typed while the service was dead'), { wait: false });
  assert.equal(await w.tip(), agentCommit, 'nothing of the human text is on GitHub yet');
  const b2 = await w.startBridge({ ...OPTS, debounceMs: 1000, port: b.port });
  assert.equal(b2.count('session-recovered'), 1);
  // the editor comes back by itself and hands over what was typed meanwhile
  await until(() => ada.client.synced && !ada.client.pending(), 'the editor to reconnect', 20000);
  await until(() => b2.count('flush') >= 2, 'the commit of what was typed while the service was dead', 30000);
  const expected = replaceLine(17, 'line 17 agent while the service was dead')(replaceLine(6, 'line 06 typed while the service was dead')(replaceLine(5, 'line 05 typed before the crash')(DOC)));
  assert.equal(await settled(w, b2), expected);
  assert.equal((await w.freshClone()).text('docs/x.md'), expected);
  assert.equal(b2.of('flush')[0].reason, 'recover');
  assert.deepEqual(await w.branches(), []);
  await w.assertMainOnlyMovedForward();
});

test('webhook path: a delivery shaped like GitHub\'s for a real push, signed with the shared secret, makes the service fetch', async () => {
  const w = await world('gh-webhook');
  const secret = `s-${Math.random().toString(36).slice(2)}${Date.now()}`;
  // polling practically off: only the delivery can tell the service that main moved
  const b = await w.startBridge({ ...OPTS, pollMs: 3600000, env: { LIVE_BRIDGE_WEBHOOK_SECRET: secret } });
  const ada = await b.human();
  const a = await w.clone('a');
  const beforeSha = await w.tip();
  const commit = await a.change('docs/x.md', replaceLine(9, 'line 09 pushed to GitHub by an agent'));
  assert.equal((await git(w.dir, ['ls-remote', REMOTE, 'refs/heads/main'])).trim().split(/\s+/)[0], commit, 'the push is on GitHub');
  await sleep(1500);
  assert.ok(!ada.text().includes('pushed to GitHub'), 'nothing happens without a delivery');
  // the fields of GitHub's push event, filled in from the real push
  const info = await w.commitInfo(commit);
  const [owner, name] = w.slug.split('/');
  const entry = { id: commit, tree_id: (await git(w.bare, ['rev-parse', `${commit}^{tree}`])).trim(), distinct: true, message: info.subject, timestamp: new Date().toISOString(), url: `https://github.com/${w.slug}/commit/${commit}`, author: { name: info.an, email: info.ae }, committer: { name: info.cn, email: info.ce }, added: [], removed: [], modified: ['docs/x.md'] };
  const payload = JSON.stringify({ ref: 'refs/heads/main', before: beforeSha, after: commit, repository: { name, full_name: w.slug, private: true, owner: { name: owner, login: owner }, html_url: `https://github.com/${w.slug}`, default_branch: 'main', master_branch: 'main' }, pusher: { name: owner }, sender: { login: owner, type: 'User' }, created: false, deleted: false, forced: false, base_ref: null, compare: `https://github.com/${w.slug}/compare/${beforeSha.slice(0, 12)}...${commit.slice(0, 12)}`, commits: [entry], head_commit: entry });
  const post = (body, sig) => fetch(`${b.origin}/webhook/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'GitHub-Hookshot/test', 'x-github-event': 'push', 'x-github-delivery': crypto.randomUUID(), 'x-github-hook-installation-target-type': 'repository', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body });
  const sign = (body, key) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
  assert.equal((await post(payload, sign(payload, 'not-the-secret'))).status, 401);
  await sleep(800);
  assert.ok(!ada.text().includes('pushed to GitHub'), 'a delivery with a wrong signature does nothing');
  const t0 = Date.now();
  const r = await post(payload, sign(payload, secret));
  assert.deepEqual([r.status, (await r.json()).action], [202, 'poked']);
  await until(() => ada.text().includes('line 09 pushed to GitHub by an agent'), 'the pushed text in the editor', 15000);
  console.log(`# signed delivery -> text in the editor: ${Date.now() - t0} ms (one fetch from GitHub, no polling)`);
  assert.equal(ada.of('notice').find((n) => n.kind === 'fold').commit, commit);
});

test('browser: typing in the editor lands on GitHub; an agent push appears in the editor with the notice', async () => {
  const w = await world('gh-browser');
  const b = await w.startBridge(OPTS);
  const token = await signIn(b.origin, 'Ada Human', 'ada@humans.test');
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await context.addInitScript(([t, u]) => { localStorage.setItem('lb.token', t); localStorage.setItem('lb.user', u); }, [token, JSON.stringify({ name: 'Ada Human', email: 'ada@humans.test' })]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${b.origin}/r/${w.slug}/edit/docs/x.md`);
  await page.locator('[data-testid="save-state"][data-phase="saved"]').waitFor();
  await page.evaluate(() => { window.__neverReloaded = true; });
  const value = () => page.evaluate(() => window.__lb.view.state.doc.toString());
  const typeAtEndOfLine = async (prefix, text) => {
    await page.evaluate((p) => { const v = window.__lb.view; const d = v.state.doc.toString(); v.focus(); v.dispatch({ selection: { anchor: d.indexOf('\n', d.indexOf(p)) } }); }, prefix);
    await page.keyboard.type(text, { delay: 20 });
  };
  const a = await w.clone('a');
  let expected = DOC;

  const typeMs = [];
  for (let i = 0; i < 6; i++) {
    const n = 2 + i;
    const before = b.count('flush');
    await typeAtEndOfLine(`line ${String(n).padStart(2, '0')} `, ` typed ${i}`);
    const t0 = Date.now();
    await until(() => b.count('flush') > before, 'the flush', 30000, 20);
    typeMs.push(Date.parse(b.of('flush').at(-1).at) - t0);
    expected = replaceLine(n, `line ${String(n).padStart(2, '0')} original typed ${i}`)(expected);
    await sleep(500);
  }
  console.log(`# last keystroke -> commit accepted by GitHub (debounce 1000 ms): ${typeMs.join(', ')} ms; ${summary(typeMs)}`);
  assert.equal((await w.freshClone()).text('docs/x.md'), expected);
  await page.locator('[data-testid="save-state"][data-phase="saved"]').waitFor();
  assert.ok((await page.getByTestId('save-state').textContent()).includes(await w.tip()), 'the status line names the commit on GitHub in full');

  const fromDone = [];
  const fromStart = [];
  let last = null;
  for (let i = 0; i < 8; i++) {
    const n = 12 + i;
    await a.pull();
    expected = replaceLine(n, `line ${n} agent round ${i}`)(a.read('docs/x.md'));
    a.write('docs/x.md', expected);
    await a.git(['commit', '--quiet', '-am', `agent round ${i}`]);
    last = (await a.git(['rev-parse', 'HEAD'])).trim();
    const seen = page.waitForFunction((needle) => window.__lb.view.state.doc.toString().includes(needle), `agent round ${i}`, { timeout: 40000 });
    const t0 = performance.now();
    await a.git(['push', '--quiet', 'origin', 'HEAD:main']);
    const t1 = performance.now();
    await seen;
    fromStart.push(Math.round(performance.now() - t0));
    fromDone.push(Math.round(performance.now() - t1));
    await sleep(700);
  }
  console.log(`# agent push returned -> visible in the browser (poll ${POLL_MS} ms): ${fromDone.join(', ')} ms; ${summary(fromDone)}`);
  console.log(`# agent push started -> visible in the browser: ${summary(fromStart)}`);
  assert.equal(await value(), expected);
  assert.equal(await page.getByTestId('fold-commit').first().textContent(), last, 'the notice names the last agent commit in full');
  assert.equal(await page.getByTestId('fold-author').first().textContent(), 'Agent a');
  assert.equal((await w.freshClone()).text('docs/x.md'), expected);
  assert.equal(await page.evaluate(() => window.__neverReloaded), true, 'no reload');
  assert.deepEqual(errors, []);
  assert.equal(lineOf(expected, 2), 'line 02 original typed 0');
  await w.assertMainOnlyMovedForward();
  await context.close();
});
