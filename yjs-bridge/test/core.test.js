// Tier 2: the service as its own process, a bare repository on disk as the git host, agents as
// separate clones driven by real git, and headless Yjs clients playing the humans. No browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { DOC, git, lineOf, makeWorld, replaceLine, sleep, until } from './helpers.js';
import { fromLF, toLF, diffOps, applyOps } from '../src/text.js';

const worlds = [];
after(async () => { for (const w of worlds) await w.stop(); });

async function world(name, opts) {
  const w = await makeWorld(name, opts);
  worlds.push(w);
  return w;
}

// the room (as a newly arriving editor gets it), main and the bridge's view all agree
async function settled(w, b, file = 'docs/x.md') {
  let state;
  await until(async () => {
    const s = await b.session(file);
    state = { live: toLF(await b.fresh(file)), main: await w.main(file), dirty: s?.dirty, behind: s?.behind };
    return state.live === toLF(state.main) && state.dirty === false && state.behind === false;
  }, 'live text and main to agree', 20000, 100).catch((e) => { assert.equal(state.live, toLF(state.main), `live text equals main (${e.message}, ${JSON.stringify({ dirty: state.dirty, behind: state.behind })})`); throw e; });
  return state.main;
}

test('text plumbing: line endings survive, edits are minimal', () => {
  for (const raw of ['a\r\nb\r\nc\r\n', 'a\nb\r\nc', 'a\rb\rc\r', 'no newline', '', '\r\n', 'x\r\n\r\ny']) assert.equal(fromLF(toLF(raw), raw), raw);
  assert.equal(fromLF('a\nB changed\nc\nnew\n', 'a\r\nb\r\nc\r\n'), 'a\r\nB changed\r\nc\r\nnew\r\n');
  assert.equal(fromLF('a\nb\nc', 'a\nb\r\nc'), 'a\nb\r\nc');
  assert.equal(fromLF('a\nb2\nc', 'a\nb\r\nc'), 'a\nb2\r\nc', 'an edited line keeps its own ending in a file with mixed endings');
  const a = 'one two three\nfour five six\nseven\n';
  const b = 'one two three\nfour FIVE six\nseven\neight\n';
  const ops = diffOps(a, b);
  assert.equal(applyOps(a, ops), b);
  assert.deepEqual(ops, [{ index: 19, remove: 4, insert: 'FIVE' }, { index: 34, remove: 0, insert: 'eight\n' }]);
});

test('a human edit reaches main after the debounce, authored as the human', async () => {
  const w = await world('t-edit');
  const b = await w.startBridge({ debounceMs: 1000 });
  const before = await w.tip();
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  assert.equal(ada.room.base, before);
  assert.equal(ada.text(), DOC, 'the room starts as main:docs/x.md');
  assert.equal((await b.session()).dirty, false);

  const t0 = Date.now();
  await ada.edit(replaceLine(3, 'line 03 SECRETWORD typed by a human'));
  await sleep(300);
  assert.equal((await b.session()).dirty, true, 'status shows unflushed text');
  assert.equal(await w.tip(), before, 'nothing is committed before the typing pause is over');
  const f = await b.waitFor('flush');
  const ms = Date.now() - t0;
  assert.ok(ms >= 1000 && ms < 3000, `flushed ${ms} ms after the edit (debounce 1000 ms)`);
  console.log(`# human edit on main ${ms} ms after the edit (debounce 1000 ms)`);

  const tip = await w.tip();
  assert.equal(f.commit, tip);
  const c = await w.commitInfo(tip);
  assert.deepEqual([c.an, c.ae], ['Ada Human', 'ada@humans.test'], 'author is the human');
  assert.deepEqual([c.cn, c.ce], ['live-bridge', 'live-bridge@localhost'], 'committer is the bridge');
  assert.equal(c.subject, 'Live edit docs/x.md: +1 -1 lines');
  assert.equal(c.body, '');
  assert.deepEqual(c.parents, [before]);
  assert.equal(await w.main('docs/x.md'), replaceLine(3, 'line 03 SECRETWORD typed by a human')(DOC));
  assert.doesNotMatch(JSON.stringify(c), /SECRETWORD/, 'the commit message quotes no document text');
  const s = await b.session();
  assert.equal(s.dirty, false);
  assert.equal(s.base, tip);
  await until(() => ada.room.base === tip && ada.room.dirty === false, 'the editor to be told about the commit');
  assert.equal(ada.of('notice').find((n) => n.kind === 'saved').commit, tip);

  // room state: on disk, private, outside the repository; no document text in events, log or status
  assert.ok(!path.resolve(w.state).startsWith(path.resolve(w.bare) + path.sep), 'state is outside the repository');
  const rooms = path.join(w.state, w.slug.replace('/', '__'), 'rooms');
  const logs = readdirSync(rooms).filter((f) => f.endsWith('.log'));
  assert.equal(logs.length, 1);
  assert.equal(statSync(path.join(rooms, logs[0])).mode & 0o777, 0o600);
  assert.equal(statSync(rooms).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(b.events).includes('SECRETWORD'), 'no document text in the event stream');
  assert.ok(!b.stderr.includes('SECRETWORD'), 'no document text in the log');
  assert.ok(!JSON.stringify(await b.status()).includes('SECRETWORD'), 'no document text in status');
});

test('an agent commit to another file changes neither the room nor main beyond that commit', async () => {
  const w = await world('t-other');
  const b = await w.startBridge();
  const ada = await b.human();
  let updates = 0;
  ada.doc.on('update', () => { updates += 1; });
  const a = await w.clone('a');
  const commit = await a.change('docs/other.md', (t) => t + 'more\n');
  await until(async () => (await b.session()).base === commit, 'the base to advance');
  await sleep(2500);
  assert.equal(await w.tip(), commit, 'no extra commit');
  assert.equal(ada.text(), DOC);
  assert.equal(updates, 0, 'the editor saw no change of the document');
  assert.equal(b.count('flush'), 0);
  assert.equal(b.count('fold'), 0);
});

test('an agent commit on other lines of the open file appears in the editor; both edits end on main', async () => {
  const w = await world('t-merge');
  const b = await w.startBridge({ debounceMs: 1500 });
  const ada = await b.human();
  const a = await w.clone('a');
  // the human has unflushed text on line 4 when the agent's commit to line 15 lands
  await ada.edit(replaceLine(4, 'line 04 human edit'));
  const t0 = Date.now();
  const agentCommit = await a.change('docs/x.md', replaceLine(15, 'line 15 agent edit'));
  await until(() => ada.text().includes('line 15 agent edit'), 'the agent edit in the editor');
  console.log(`# agent push -> visible in a connected editor: ${Date.now() - t0} ms (includes the push itself)`);
  assert.ok(ada.text().includes('line 04 human edit'), 'the human text is still there');
  const n = ada.of('notice').find((x) => x.kind === 'fold');
  assert.equal(n.commit, agentCommit, 'the notice names the full commit');
  assert.equal(n.author.name, 'Agent a');
  assert.equal(await w.tip(), agentCommit, 'the human edit is not flushed yet');
  const f = await b.waitFor('flush');
  const expected = replaceLine(15, 'line 15 agent edit')(replaceLine(4, 'line 04 human edit')(DOC));
  assert.equal(await settled(w, b), expected);
  assert.deepEqual((await w.commitInfo(f.commit)).parents, [agentCommit], 'the human commit sits on top of the agent commit');
  assert.equal((await w.commitInfo(f.commit)).subject, 'Live edit docs/x.md: +1 -1 lines');
  assert.deepEqual(await w.branches(), [], 'no conflict branch');
  assert.equal(b.count('conflict'), 0);
});

test('a fold touches only what changed: a cursor on another line stays where it was', async () => {
  const w = await world('t-minimal');
  const b = await w.startBridge({ debounceMs: 60000 });
  const ada = await b.human();
  const bob = await b.human('docs/x.md', 'Bob Human', 'bob@humans.test');
  // Ada's cursor sits inside "original" of line 12, Bob has a selection over line 18
  const at = (text, needle, off = 0) => text.indexOf(needle) + off;
  const cursor = Y.createRelativePositionFromTypeIndex(ada.ytext, at(ada.text(), 'line 12 original', 11));
  const selFrom = Y.createRelativePositionFromTypeIndex(bob.ytext, at(bob.text(), 'line 18 original'));
  const selTo = Y.createRelativePositionFromTypeIndex(bob.ytext, at(bob.text(), 'line 18 original', 16));
  const deltas = [];
  ada.ytext.observe((ev, tr) => { if (tr.origin === ada.client) deltas.push(ev.delta); });
  const a = await w.clone('a');
  // the agent changes one word on line 5, inserts a line after line 8 and removes line 15
  const agentCommit = await a.change('docs/x.md', (t) => t.replace('line 05 original', 'line 05 rewritten').replace('line 08 original\n', 'line 08 original\ninserted by the agent\n').replace('line 15 original\n', ''));
  await until(() => ada.text().includes('inserted by the agent') && bob.text().includes('inserted by the agent'), 'the agent edit in both editors');
  const expected = await w.main('docs/x.md');
  assert.equal(ada.text(), expected);
  assert.equal(bob.text(), expected);

  const abs = Y.createAbsolutePositionFromRelativePosition(cursor, ada.doc).index;
  assert.equal(ada.text().slice(abs - 11, abs + 5), 'line 12 original', 'the cursor is still between the same characters');
  const f = Y.createAbsolutePositionFromRelativePosition(selFrom, bob.doc).index;
  const t = Y.createAbsolutePositionFromRelativePosition(selTo, bob.doc).index;
  assert.equal(bob.text().slice(f, t), 'line 18 original', 'the selection still covers the same text');

  // what travelled: one transaction with three small edits, not a rewrite of the document
  assert.equal(deltas.length, 1, 'one transaction');
  const inserted = deltas[0].filter((d) => d.insert).map((d) => d.insert);
  const deleted = deltas[0].filter((d) => d.delete).reduce((n, d) => n + d.delete, 0);
  assert.deepEqual(inserted, ['rewritten', 'inserted by the agent\n']);
  assert.equal(deleted, 'original'.length + 'line 15 original\n'.length);
  assert.equal(ada.of('notice').find((x) => x.kind === 'fold').commit, agentCommit);
  assert.equal(b.count('flush'), 0, 'nothing of this is a human edit');
  assert.equal((await b.session()).dirty, false);
});

test('clashing edits: main keeps its lines, the room takes them, the human text goes to a conflict branch', async () => {
  const w = await world('t-conflict');
  const b = await w.startBridge({ debounceMs: 3000 });
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const base = ada.room.base;
  const a = await w.clone('a');
  // human: line 7 (will clash) and line 12 (will not)
  await ada.edit((t) => replaceLine(12, 'line 12 human, no overlap')(replaceLine(7, 'rewritten completely by the HUMAN')(t)));
  const humanText = ada.text();
  const agentCommit = await a.change('docs/x.md', replaceLine(7, 'line 07 replaced with other words by the AGENT'));
  const ev = await b.waitFor('conflict');
  assert.equal(await w.main('docs/x.md', agentCommit), replaceLine(7, 'line 07 replaced with other words by the AGENT')(DOC));

  // room: main's version of the clashing line, the other human edit kept
  const merged = replaceLine(12, 'line 12 human, no overlap')(replaceLine(7, 'line 07 replaced with other words by the AGENT')(DOC));
  await until(() => ada.text() === merged, 'the merged text in the editor');
  assert.equal(lineOf(ada.text(), 7), 'line 07 replaced with other words by the AGENT');

  // conflict branch: complete pre-merge human text, parent = the room's base commit
  const branches = await w.branches();
  assert.equal(branches.length, 1);
  assert.match(branches[0], /^conflict\/ada-human\/docs_x\.md-\d{8}T\d{9}Z$/);
  assert.equal(ev.branch, branches[0]);
  assert.equal(ev.pushed, true);
  assert.equal(await w.main('docs/x.md', branches[0]), humanText);
  const cc = await w.commitInfo(branches[0]);
  assert.deepEqual(cc.parents, [base], 'parent of the conflict commit is the room base');
  assert.deepEqual([cc.an, cc.ae, cc.ce], ['Ada Human', 'ada@humans.test', 'live-bridge@localhost']);
  assert.equal(ev.commit, await w.tip(branches[0]));
  assert.equal(ev.mainCommit, agentCommit);
  assert.deepEqual(ev.lines, [9], 'line 07 of the list is line 9 of the file');
  assert.doesNotMatch(`${cc.subject}\n${cc.body}`, /HUMAN/);

  // the editor is told: who, which commit, which branch, all in full
  const told = await until(() => ada.of('conflict')[0], 'the conflict message in the editor');
  assert.equal(told.branch, branches[0]);
  assert.equal(told.mainCommit, agentCommit);
  assert.equal(told.mainAuthor, 'Agent a');

  // main: the agent's line stays; the other human edit lands with the next flush
  assert.equal(await settled(w, b), merged);
  const log = (await git(w.bare, ['log', '--format=%an', 'main'])).trim().split('\n');
  assert.deepEqual(log, ['Ada Human', 'Agent a', 'Agent seed']);
  assert.ok(!(await git(w.bare, ['log', '-p', 'main'])).includes('HUMAN'), 'the clashing human line never reached main');

  const st = await b.status();
  assert.equal(st.conflicts.length, 1);
  assert.equal(st.conflicts[0].branch, branches[0]);
  assert.equal(st.sessions[0].conflicts.length, 1);
  assert.equal(await w.assertMainOnlyMovedForward(), 2);
});

test('the same line changed in different words by a human and an agent: merged word by word, no conflict', async () => {
  const w = await world('t-words', { files: { 'docs/x.md': '# Plan\n\nThe launch is planned for March and the budget is ten thousand euros in total.\n\nlast line\n' } });
  const b = await w.startBridge({ debounceMs: 1200 });
  const ada = await b.human();
  const a = await w.clone('a');
  await ada.edit((t) => t.replace('March', 'April'));
  await a.change('docs/x.md', (t) => t.replace('ten thousand', 'twelve thousand'));
  const want = '# Plan\n\nThe launch is planned for April and the budget is twelve thousand euros in total.\n\nlast line\n';
  await until(() => ada.text() === want, 'both changes in the editor');
  const fold = await b.waitFor('fold');
  assert.equal(fold.wordMerges, 1);
  assert.equal(fold.conflicts, 0);
  assert.equal(await settled(w, b), want);
  assert.deepEqual(await w.branches(), []);
});

test('hold: a clashing change waits until the person stops typing, then swaps the line', async () => {
  const w = await world('t-hold');
  const b = await w.startBridge({ debounceMs: 4000, holdMs: 700 });
  const ada = await b.human();
  const a = await w.clone('a');
  await ada.edit(replaceLine(7, 'human rewrites this one'));
  let typing = true;
  let n = 0;
  const typer = (async () => { while (typing) { await ada.edit((t) => t.replace(/^(human rewrites this one.*)$/m, `$1 w${n++}`)); await sleep(150); } })();
  const agentCommit = await a.change('docs/x.md', replaceLine(7, 'line 07 AGENT says something else entirely'));
  await b.waitFor('fold-held');
  await sleep(1500);
  assert.ok(lineOf(ada.text(), 7) === undefined && ada.text().includes('human rewrites this one'), 'while typing goes on the line is the human\'s');
  assert.equal(b.count('conflict'), 0, 'not swapped yet');
  assert.equal((await b.session()).held, true);
  typing = false;
  await typer;
  const stoppedAt = Date.now();
  const humanText = ada.text();
  const ev = await b.waitFor('conflict');
  const waited = ev.seenAt - stoppedAt;
  assert.ok(waited >= 600 && waited < 2500, `swapped ${waited} ms after the last keystroke (hold 700 ms)`);
  console.log(`# held clash swapped ${waited} ms after the last keystroke (hold 700 ms)`);
  await until(() => lineOf(ada.text(), 7) === 'line 07 AGENT says something else entirely', 'main\'s line in the editor');
  assert.equal(await w.main('docs/x.md', ev.branch), humanText, 'the branch holds everything typed up to the swap');
  assert.equal(ev.mainCommit, agentCommit);
  assert.equal(await settled(w, b), await w.main('docs/x.md', agentCommit));
});

test('a bridge push that is behind main (non-fast-forward) is retried after folding', async () => {
  const w = await world('t-nonff');
  // no hook and no polling: the bridge only learns that main moved from its own rejected push
  const b = await w.startBridge({ hooks: false, pollMs: 3600000, debounceMs: 1000 });
  const ada = await b.human();
  const a = await w.clone('a');
  const agentCommit = await a.change('docs/x.md', replaceLine(18, 'line 18 agent edit'));
  await ada.edit(replaceLine(2, 'line 02 human edit'));
  const f = await b.waitFor('flush');
  assert.equal(b.count('push-rejected'), 1);
  assert.match(b.of('push-rejected')[0].reason, /fetch first|non-fast-forward/);
  assert.equal(f.attempt, 1, 'landed on the second try');
  assert.deepEqual((await w.commitInfo(f.commit)).parents, [agentCommit]);
  assert.deepEqual([(await w.commitInfo(f.commit)).an], ['Ada Human'], 'the author survives the retry');
  const expected = replaceLine(18, 'line 18 agent edit')(replaceLine(2, 'line 02 human edit')(DOC));
  assert.equal(await settled(w, b), expected);
  assert.equal(ada.text(), expected, 'the agent edit was folded into the editor on the way');
  await w.assertMainOnlyMovedForward();
});

test('a bridge push racing an agent push inside the host is refused by the host and retried', async () => {
  const w = await world('t-race');
  const b = await w.startBridge({ debounceMs: 800 });
  // host-side pre-receive: holds the bridge's push for 2 s once, so the agent's push lands first
  const flag = path.join(w.dir, 'hold-next-bridge-push');
  writeFileSync(path.join(w.bare, 'hooks', 'pre-receive'), `#!/bin/sh
while read old new ref; do
  if [ -f '${flag}' ] && [ "$(git log -1 --format=%ce "$new")" = "live-bridge@localhost" ]; then
    mv '${flag}' '${flag}.used'
    sleep 2
  fi
done
exit 0
`, { mode: 0o755 });
  const ada = await b.human();
  const a = await w.clone('a');
  await a.pull();
  writeFileSync(flag, '');
  await ada.edit(replaceLine(5, 'line 05 human edit'));
  await until(() => existsSync(`${flag}.used`), 'the bridge push to be in flight', 10000, 10);
  const agentCommit = await a.change('docs/x.md', replaceLine(16, 'line 16 agent edit'));
  const f = await b.waitFor('flush');
  const rejected = b.of('push-rejected');
  assert.equal(rejected.length, 1);
  console.log(`# host refused the bridge push: "${rejected[0].reason}"`);
  assert.deepEqual((await w.commitInfo(f.commit)).parents, [agentCommit]);
  const expected = replaceLine(16, 'line 16 agent edit')(replaceLine(5, 'line 05 human edit')(DOC));
  assert.equal(await settled(w, b), expected);
  assert.equal(a.rejected, 0, 'the agent was never turned away');
  assert.equal(await w.assertMainOnlyMovedForward(), 2);
  assert.deepEqual(await w.branches(), []);
});

test('polling fallback: without a hook an agent commit still reaches the editor', async () => {
  const w = await world('t-poll');
  const b = await w.startBridge({ hooks: false, pollMs: 300 });
  assert.ok(!existsSync(path.join(w.bare, 'hooks', 'post-receive')), 'no hook installed');
  const ada = await b.human();
  const a = await w.clone('a');
  await a.change('docs/x.md', replaceLine(9, 'line 09 agent edit'));
  await until(() => ada.text().includes('line 09 agent edit'), 'the agent edit in the editor', 5000);
  assert.equal(b.count('flush'), 0);
});

test('authorship follows who actually typed: author, co-author, and neither for someone who only watched', async () => {
  const w = await world('t-authors');
  const b = await w.startBridge({ debounceMs: 800 });
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const bob = await b.human('docs/x.md', 'Bob Human', 'bob@humans.test');
  const cy = await b.human('docs/x.md', 'Cy Watcher', 'cy@humans.test');
  assert.equal(ada.room.docId, bob.room.docId, 'one document for the room');
  assert.deepEqual((await b.session()).editors.map((e) => e.email).sort(), ['ada@humans.test', 'bob@humans.test', 'cy@humans.test']);

  // 1. only Bob types (Ada opened the room first and watches)
  await bob.edit(replaceLine(14, 'line 14 by bob'));
  const f1 = await b.waitFor('flush');
  let c = await w.commitInfo(f1.commit);
  assert.deepEqual([c.an, c.ae], ['Bob Human', 'bob@humans.test'], 'the one who typed is the author, not the one who opened');
  assert.equal(c.body, '', 'nobody else typed: no trailer');

  // 2. Ada types first, then Bob, before the pause is over
  await ada.edit(replaceLine(3, 'line 03 by ada'));
  await sleep(200);
  await bob.edit(replaceLine(15, 'line 15 by bob'));
  const f2 = await b.waitFor('flush', (e) => e.commit !== f1.commit);
  c = await w.commitInfo(f2.commit);
  assert.deepEqual([c.an, c.ae], ['Ada Human', 'ada@humans.test'], 'first to type is the author');
  assert.equal(c.body, 'Co-authored-by: Bob Human <bob@humans.test>');
  assert.deepEqual([c.cn, c.ce], ['live-bridge', 'live-bridge@localhost']);

  // 3. only Ada types: Bob is not carried over from the commit before
  await ada.edit(replaceLine(4, 'line 04 by ada'));
  const f3 = await b.waitFor('flush', (e) => ![f1.commit, f2.commit].includes(e.commit));
  c = await w.commitInfo(f3.commit);
  assert.deepEqual([c.an, c.body], ['Ada Human', '']);

  const expected = replaceLine(4, 'line 04 by ada')(replaceLine(15, 'line 15 by bob')(replaceLine(3, 'line 03 by ada')(replaceLine(14, 'line 14 by bob')(DOC))));
  assert.equal(await settled(w, b), expected);
  assert.equal(cy.text(), expected);
  const all = (await git(w.bare, ['log', '--format=%an%n%b', 'main'])).toString();
  assert.doesNotMatch(all, /Cy Watcher/, 'the watcher is on no commit');
  assert.equal((await b.status()).sessions.length, 1);
});

test('two humans typing at the same time in one room converge, and everything typed reaches main', async () => {
  const w = await world('t-concurrent');
  const b = await w.startBridge({ debounceMs: 700 });
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const bob = await b.human('docs/x.md', 'Bob Human', 'bob@humans.test');
  const N = 60;
  // keystroke by keystroke, without waiting for each other: Ada appends words to the end of line 3;
  // Bob appends to line 4 and, every fifth word, types into Ada's line right behind "line 03"
  const typeWord = (h, lineNo, word, atStart = false) => {
    const text = h.text();
    const line = `line ${String(lineNo).padStart(2, '0')}`;
    const start = text.indexOf(line);
    const at = atStart ? start + line.length : text.indexOf('\n', start);
    for (let i = 0; i < word.length; i++) h.type(at + i, word[i]);
  };
  await Promise.all([
    (async () => { for (let i = 0; i < N; i++) { typeWord(ada, 3, ` a${i}`); await sleep(7); } })(),
    (async () => { for (let i = 0; i < N; i++) { typeWord(bob, i % 5 === 4 ? 3 : 4, ` b${i}`, i % 5 === 4); await sleep(9); } })(),
  ]);
  // and both at the very same spot, character by character: the order between them is the
  // CRDT's choice, but nothing may be lost and both must see the same
  const spot = ada.text().indexOf('line 10 original') + 'line 10'.length;
  await Promise.all([
    (async () => { for (const ch of 'AAAAAAAAAAAAAAAAAAAA') { ada.type(spot, ch); await sleep(5); } })(),
    (async () => { for (const ch of 'BBBBBBBBBBBBBBBBBBBB') { bob.type(spot, ch); await sleep(6); } })(),
  ]);
  await ada.settle();
  await bob.settle();
  await until(() => ada.text() === bob.text() && (ada.text().match(/[AB]/g) || []).length === 40, 'both editors to show the same text');
  const text = ada.text();
  if (process.env.DEBUG_TEXT) console.log(text);
  for (let i = 0; i < N; i++) {
    assert.match(text, new RegExp(` a${i}( |\n)`), `a${i} is there as typed`);
    assert.match(text, new RegExp(` b${i}( |\n)`), `b${i} is there as typed`);
  }
  assert.equal((text.match(/ a\d+/g) || []).length, N, 'no word of Ada lost or doubled');
  assert.equal((text.match(/ b\d+/g) || []).length, N, 'no word of Bob lost or doubled');
  assert.equal((text.match(/A/g) || []).length, 20);
  assert.equal((text.match(/B/g) || []).length, 20);
  assert.match(text, /^line 10[AB]{40} original$/m, 'the 40 characters typed at one spot are all at that spot');
  assert.equal(text.split('\n').length, DOC.split('\n').length, 'no line was split or joined');
  assert.equal(await settled(w, b), text);
  const authors = new Set((await w.logSince('%an')));
  assert.ok(authors.has('Ada Human') || authors.has('Bob Human'));
  const withBoth = (await w.logSince('%an|%b')).join('\n');
  assert.match(withBoth, /Co-authored-by: (Ada|Bob) Human/, 'a commit that holds text of both names both');
});

test('typing without a pause is flushed after max-wait', async () => {
  const w = await world('t-maxwait');
  const b = await w.startBridge({ debounceMs: 1000, maxWaitMs: 2500 });
  const ada = await b.human();
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 6000) {
    await ada.edit((t) => t + `k${i++} `);
    await sleep(250);
  }
  const during = b.of('flush').filter((f) => f.seenAt - t0 < 6000);
  assert.ok(during.length >= 1, 'at least one flush while the typing went on');
  assert.ok(during.every((f) => f.reason === 'max-wait'), `reasons: ${during.map((f) => f.reason)}`);
  assert.ok(during[0].seenAt - t0 >= 2400 && during[0].seenAt - t0 < 4500, `first flush after ${during[0].seenAt - t0} ms`);
  await settled(w, b);
  assert.ok((await w.main('docs/x.md')).includes(`k${i - 1} `));
});

test('session end: the last editor leaves, the text is flushed; the next session starts from main', async () => {
  const w = await world('t-end');
  // long debounce: only the end of the session can have flushed
  const b = await w.startBridge({ debounceMs: 60000, emptyMs: 1000 });
  const ada = await b.human();
  await ada.edit(replaceLine(6, 'line 06 typed just before leaving'));
  ada.close();
  const closed = await b.waitFor('session-close');
  assert.equal(closed.reason, 'no-participants');
  const expected = replaceLine(6, 'line 06 typed just before leaving')(DOC);
  assert.equal(await w.main('docs/x.md'), expected);
  assert.equal(closed.commit, await w.tip());
  assert.equal(b.of('flush')[0].reason, 'session-end');
  assert.deepEqual((await w.commitInfo(closed.commit)).an, 'Ada Human');
  await until(async () => (await b.status()).sessions.length === 0, 'the room to leave memory');

  // an agent moves main while no session is open; the next one starts from that
  const a = await w.clone('a');
  await a.change('docs/x.md', replaceLine(11, 'line 11 agent edit'));
  const expected2 = replaceLine(11, 'line 11 agent edit')(expected);
  const ada2 = await b.human();
  assert.equal(ada2.text(), expected2);
  assert.equal(ada2.room.docId, ada.room.docId, 'the stored document goes on');
  assert.equal(ada2.room.seq, 2, 'as a new session');
  assert.equal(b.count('flush'), 1, 'opening made no commit');

  // explicit close while the room is dirty flushes too
  await ada2.edit(replaceLine(1, 'line 01 before the close request'));
  const r = await b.close('docs/x.md');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.commit, await w.tip());
  assert.equal(await w.main('docs/x.md'), replaceLine(1, 'line 01 before the close request')(expected2));
  assert.equal((await b.close('docs/x.md')).status, 404, 'closing twice reports that there is no session');
  await w.assertMainOnlyMovedForward();
});

test('an ended session is shown as ended, and typing into it starts a new one instead of being dropped', async () => {
  const w = await world('t-ended');
  const b = await w.startBridge({ debounceMs: 600, idleMs: 2500, emptyMs: 600000 });
  const before = await w.tip();
  const ada = await b.human();
  const c1 = await b.waitFor('session-close', undefined, 10000);
  assert.equal(c1.reason, 'idle');
  assert.equal(c1.commit, null, 'nothing to flush');
  assert.equal(await w.tip(), before, 'no commit was made');
  await until(() => ada.room.session === 'ended', 'the editor to be told that the session ended');
  assert.equal(ada.room.endReason, 'idle');

  // main moves while the session is ended: the page does not follow (and says so through its state)
  const a = await w.clone('a');
  const agentCommit = await a.change('docs/x.md', replaceLine(15, 'line 15 agent edit'));
  await sleep(1200);
  assert.ok(!ada.text().includes('agent edit'));

  // typing: a new session, nothing dropped, main's change folded in
  await ada.edit(replaceLine(2, 'line 02 typed into an ended session'));
  await until(() => ada.room.session === 'live' && ada.room.seq === 2, 'a new session');
  const f = await b.waitFor('flush');
  const expected = replaceLine(15, 'line 15 agent edit')(replaceLine(2, 'line 02 typed into an ended session')(DOC));
  assert.equal(await settled(w, b), expected);
  assert.equal(ada.text(), expected);
  assert.deepEqual((await w.commitInfo(f.commit)).parents, [agentCommit]);
  assert.equal(b.of('session-open').length, 2);
});

test('a session nobody connects to ends by itself', async () => {
  const w = await world('t-nobody');
  const b = await w.startBridge({ joinGraceMs: 1500, emptyMs: 600000 });
  const before = await w.tip();
  assert.equal(await b.fresh('docs/x.md'), DOC, 'the text was fetched over HTTP only');
  const c1 = await b.waitFor('session-close', undefined, 10000);
  assert.equal(c1.reason, 'nobody-joined');
  assert.equal(await w.tip(), before);
  await until(async () => (await b.status()).sessions.length === 0, 'the room to leave memory');
});

test('opening what is not there fails cleanly; with the service gone git works as ever and the room catches up later', async () => {
  const w = await world('t-down');
  let b = await w.startBridge({ debounceMs: 500 });
  const before = await w.tip();
  await assert.rejects(b.human('docs/nope.md'), /404/);
  await assert.rejects(b.human('../outside.md'), /400/);
  assert.equal(await w.tip(), before);
  assert.deepEqual((await b.status()).sessions, []);
  const ada = await b.human();
  await ada.edit(replaceLine(2, 'line 02 human edit'));
  await b.waitFor('flush');

  // the service is stopped: agents notice nothing
  await b.stop();
  const a = await w.clone('a');
  const t0 = Date.now();
  const c1 = await a.change('docs/x.md', replaceLine(12, 'line 12 agent edit'));
  const c2 = await a.change('docs/other.md', (t) => t + 'x\n');
  assert.equal(a.rejected, 0);
  assert.ok(Date.now() - t0 < 5000, 'pushes are not slowed down by the missing service');
  assert.deepEqual((await w.commitInfo(c2)).parents, [c1]);
  // typed while the service is away: stays in the editor
  await ada.edit(replaceLine(8, 'line 08 typed while the service was down'), { wait: false });
  assert.equal(await w.tip(), c2);

  b = await w.startBridge({ debounceMs: 500, port: b.port });
  const expected = replaceLine(8, 'line 08 typed while the service was down')(replaceLine(12, 'line 12 agent edit')(replaceLine(2, 'line 02 human edit')(DOC)));
  await until(() => ada.text() === expected, 'the editor to reconnect by itself and catch up', 20000);
  assert.equal(await settled(w, b), expected);
  await w.assertMainOnlyMovedForward();
});

test('an editor that loses its connection keeps typing; after it is back both sides converge', async () => {
  const w = await world('t-outage');
  const b = await w.startBridge({ debounceMs: 800 });
  const ada = await b.human();
  const bob = await b.human('docs/x.md', 'Bob Human', 'bob@humans.test');
  await ada.edit(replaceLine(2, 'line 02 human before the outage'));
  await b.waitFor('flush');

  // Ada's network goes away (her client would reconnect at once, so it is held off)
  ada.client.closed = true;
  ada.client.drop();
  await until(async () => (await b.session()).editors.length === 1, 'the service to see her gone');
  const a = await w.clone('a');
  await a.change('docs/x.md', replaceLine(17, 'line 17 agent during the outage'));
  await bob.edit(replaceLine(11, 'line 11 bob during the outage'));
  await ada.edit(replaceLine(8, 'line 08 ada during the outage'), { wait: false });
  await ada.edit(replaceLine(9, 'line 09 ada during the outage'), { wait: false });
  await sleep(1500);
  assert.ok(ada.client.pending(), 'her editor knows it holds unconfirmed text');
  assert.ok(!ada.text().includes('agent during the outage'));
  assert.ok(!(await w.main('docs/x.md')).includes('ada during the outage'));

  ada.client.closed = false;
  ada.client.connect();
  const expected = [[8, 'line 08 ada during the outage'], [9, 'line 09 ada during the outage'], [11, 'line 11 bob during the outage'], [17, 'line 17 agent during the outage'], [2, 'line 02 human before the outage']].reduce((t, [n, l]) => replaceLine(n, l)(t), DOC);
  await until(() => ada.text() === expected && bob.text() === expected, 'both editors to converge');
  assert.equal(await settled(w, b), expected);
  const last = await w.commitInfo(await w.tip());
  assert.equal(last.an, 'Ada Human', 'what she typed offline is committed under her name');
  assert.deepEqual(await w.branches(), []);
  await w.assertMainOnlyMovedForward();
});

test('the file mode and every other file of the tree are kept by a live-edit commit', async () => {
  const w = await world('t-mode');
  const a = await w.clone('a');
  chmodSync(path.join(a.dir, 'docs/x.md'), 0o755);
  a.write('dir with space/file "quoted".md', 'odd name\n');
  await a.git(['add', '-A']);
  await a.git(['commit', '--quiet', '-m', 'mode and an odd file name']);
  await a.push();
  const b = await w.startBridge({ debounceMs: 500 });
  const before = (await git(w.bare, ['ls-tree', '-r', 'main'])).trim().split('\n');
  assert.match(before.find((l) => l.endsWith('\tdocs/x.md')), /^100755 blob /, 'executable before');
  const ada = await b.human();
  await ada.edit(replaceLine(3, 'line 03 human edit'));
  await b.waitFor('flush');
  const afterTree = (await git(w.bare, ['ls-tree', '-r', 'main'])).trim().split('\n');
  assert.equal(afterTree.length, before.length);
  assert.deepEqual(afterTree.filter((l) => !l.endsWith('\tdocs/x.md')), before.filter((l) => !l.endsWith('\tdocs/x.md')), 'all other entries are identical');
  assert.match(afterTree.find((l) => l.endsWith('\tdocs/x.md')), /^100755 blob /, 'still executable');
  // a file whose name needs quoting can be edited too
  const ada2 = await b.human('dir with space/file "quoted".md');
  await ada2.edit((t) => t + 'second line\n');
  await b.waitFor('flush', (f) => f.path === 'dir with space/file "quoted".md');
  assert.equal(await w.main('dir with space/file "quoted".md'), 'odd name\nsecond line\n');
  assert.equal((await b.status()).sessions.length, 2);
});

test('byte-exact: opening and closing makes no commit; CRLF, mixed endings and a missing final newline survive an edit', async () => {
  const crlf = '# Windows file\r\n\r\nfirst line\r\nsecond line\r\nthird line\r\n';
  const noeol = '# No newline at the end\n\nalpha\nbeta\ngamma';
  const mixed = 'unix line\nwindows line\r\nold mac line\rlast unix line\n';
  const bom = '﻿# With a byte order mark\n\ttabbed nbsp  trailing spaces  \n';
  const w = await world('t-bytes', { files: { 'docs/crlf.md': crlf, 'docs/noeol.md': noeol, 'docs/mixed.md': mixed, 'docs/bom.md': bom } });
  const b = await w.startBridge({ debounceMs: 400, emptyMs: 500 });
  const before = await w.tip();
  const blob = async (f) => (await git(w.bare, ['rev-parse', `main:${f}`])).trim();
  const blobs = {};
  for (const f of ['docs/crlf.md', 'docs/noeol.md', 'docs/mixed.md', 'docs/bom.md']) blobs[f] = await blob(f);

  // open every file, look, leave
  for (const f of Object.keys(blobs)) { const h = await b.human(f); await sleep(100); h.close(); }
  await until(() => b.count('session-close') === 4, 'all four sessions to end');
  assert.equal(await w.tip(), before, 'no commit from opening and closing');
  assert.equal(b.count('flush'), 0);

  // one word changed in each
  const edits = { 'docs/crlf.md': ['second', 'SECOND'], 'docs/noeol.md': ['beta', 'BETA'], 'docs/mixed.md': ['windows', 'WINDOWS'], 'docs/bom.md': ['tabbed', 'TABBED'] };
  const originals = { 'docs/crlf.md': crlf, 'docs/noeol.md': noeol, 'docs/mixed.md': mixed, 'docs/bom.md': bom };
  for (const [f, [from, to]] of Object.entries(edits)) {
    const h = await b.human(f);
    assert.ok(!h.text().includes('\r'), 'editors work on LF text');
    await h.edit((t) => t.replace(from, to));
    const fl = await b.waitFor('flush', (e) => e.path === f);
    assert.deepEqual([fl.added, fl.removed], [1, 1], `${f}: exactly one line changed`);
    assert.equal(await w.main(f), originals[f].replace(from, to), `${f}: every other byte as before`);
    const stat = (await git(w.bare, ['show', '--numstat', '--format=', fl.commit])).trim();
    assert.equal(stat, `1\t1\t${f}`, 'git sees one line changed');
    h.close();
  }
  // a line added to the CRLF file gets CRLF; one added after the last line of the file without a final newline does not invent one
  const h1 = await b.human('docs/crlf.md');
  await h1.edit((t) => t.replace('first line\n', 'first line\nadded line\n'));
  await b.waitFor('flush', (e) => e.path === 'docs/crlf.md' && e.added === 1 && e.removed === 0);
  assert.equal(await w.main('docs/crlf.md'), crlf.replace('second', 'SECOND').replace('first line\r\n', 'first line\r\nadded line\r\n'));
  // an agent's edit to the CRLF file reaches the editor as LF text and does not make the room dirty
  const a = await w.clone('a');
  await a.change('docs/crlf.md', (t) => t.replace('third line\r\n', 'third line by agent\r\n'));
  await until(() => h1.text().includes('third line by agent'), 'the agent edit');
  await sleep(1000);
  assert.equal((await b.session('docs/crlf.md')).dirty, false);
  assert.equal((await w.logSince('%an'))[0], 'Agent a', 'no commit followed the agent\'s');
});

test('the file is removed on main while someone has unflushed text: the text is kept on a branch, the editor is told', async () => {
  const w = await world('t-gone');
  const b = await w.startBridge({ debounceMs: 60000 });
  const ada = await b.human();
  await ada.edit(replaceLine(5, 'line 05 typed before the file went away'));
  const humanText = ada.text();
  const a = await w.clone('a');
  await a.pull();
  await a.git(['rm', '--quiet', 'docs/x.md']);
  await a.git(['commit', '--quiet', '-m', 'remove the file']);
  const gone = await a.push();
  const ev = await b.waitFor('conflict');
  assert.equal(ev.why, 'file removed on main');
  assert.equal(await w.main('docs/x.md', ev.branch), humanText);
  assert.equal(await w.main('docs/x.md'), null);
  const told = await until(() => ada.of('removed')[0], 'the editor to be told');
  assert.equal(told.commit, gone);
  assert.equal(told.branch, ev.branch);
  await until(async () => (await b.status()).sessions.length === 0, 'the room to be dropped');
});

test('webhook: a signed GitHub push delivery makes the bridge fetch; a wrong signature is refused', async () => {
  // a host of the GitHub kind whose remote is a repository on disk, with polling as good as off:
  // only the webhook can tell the bridge that main moved
  const w = await world('t-webhook');
  const secret = 'test-secret-' + Math.random().toString(36).slice(2);
  const b = await w.startBridge({ pollMs: 3600000, asGithub: true, env: { LIVE_BRIDGE_WEBHOOK_SECRET: secret } });
  const ada = await b.human();
  const a = await w.clone('a');
  const beforeSha = await w.tip();
  const commit = await a.change('docs/x.md', replaceLine(9, 'line 09 pushed by an agent'));
  await sleep(700);
  assert.ok(!ada.text().includes('pushed by an agent'), 'without a delivery nothing happens');

  const payload = JSON.stringify({ ref: 'refs/heads/main', before: beforeSha, after: commit, created: false, deleted: false, forced: false, repository: { full_name: w.slug, name: w.slug.split('/')[1], default_branch: 'main' }, pusher: { name: 'agent-a' }, commits: [{ id: commit, modified: ['docs/x.md'] }], head_commit: { id: commit } });
  const post = (body, sig, event = 'push') => fetch(`${b.origin}/webhook/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': 'test', ...(sig ? { 'x-hub-signature-256': sig } : {}) }, body });
  const sign = (body, key = secret) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

  assert.equal((await post(payload, sign(payload, 'wrong-secret'))).status, 401);
  assert.equal((await post(payload, null)).status, 401);
  assert.equal((await post(payload.replace('docs/x.md', 'docs/y.md'), sign(payload))).status, 401, 'a body changed after signing is refused');
  await sleep(500);
  assert.ok(!ada.text().includes('pushed by an agent'), 'refused deliveries do nothing');

  const other = JSON.stringify({ ...JSON.parse(payload), ref: 'refs/heads/feature' });
  const r1 = await post(other, sign(other));
  assert.deepEqual([r1.status, (await r1.json()).action], [202, 'ignored']);
  const ping = JSON.stringify({ zen: 'x', repository: { full_name: w.slug } });
  assert.equal((await (await post(ping, sign(ping), 'ping')).json()).action, 'pong');

  const t0 = Date.now();
  const r2 = await post(payload, sign(payload));
  assert.deepEqual([r2.status, (await r2.json()).action], [202, 'poked']);
  await until(() => ada.text().includes('line 09 pushed by an agent'), 'the pushed text in the editor', 5000);
  console.log(`# signed webhook delivery -> text in the editor: ${Date.now() - t0} ms`);
  assert.equal(ada.of('notice').find((n) => n.kind === 'fold').commit, commit);
});
