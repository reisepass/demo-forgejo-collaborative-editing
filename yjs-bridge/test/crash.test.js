// Tier 6: the service is killed with SIGKILL and started again on the same state directory and
// port. Headless clients play people who keep typing through all of it; they reconnect by
// themselves (the same client code the browser runs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DOC, git, lineOf, makeWorld, replaceLine, sleep, until } from './helpers.js';

const KILLS = Number(process.env.CRASH_KILLS || 20);
const worlds = [];
after(async () => { for (const w of worlds) await w.stop(); });

const between = (a, b) => a + Math.floor(Math.random() * (b - a));
const pad4 = (n) => String(n).padStart(4, '0');
const count = (text, needle) => text.split(needle).length - 1;
const appendTo = (n, word) => (doc) => doc.split('\n').map((l) => (l.startsWith(`line ${String(n).padStart(2, '0')} `) ? `${l} ${word}` : l)).join('\n');
const roomsDir = (w) => path.join(w.state, w.slug.replace('/', '__'), 'rooms');

async function quiescent(w, b, ms = 30000) {
  let state;
  await until(async () => {
    const s = await b.session();
    state = { live: await b.fresh(), main: await w.main('docs/x.md'), dirty: s?.dirty, behind: s?.behind };
    return state.live === state.main && state.dirty === false && state.behind === false;
  }, 'live text and main to agree', ms, 100).catch((e) => { assert.equal(state.live, state.main, `live text equals main (${e.message}; ${JSON.stringify({ dirty: state.dirty, behind: state.behind })})`); throw e; });
  return state.main;
}

test(`kill -9 at ${KILLS} random moments while two people type: every keystroke ends on main once, the editors reconnect by themselves`, async () => {
  const w = await makeWorld('crash');
  worlds.push(w);
  const opts = { debounceMs: 500, maxWaitMs: 1500 };
  let b = await w.startBridge(opts);
  const port = b.port;
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  const bob = await b.human('docs/x.md', 'Bob Human', 'bob@humans.test');
  const docId = ada.room.docId;
  const a = await w.clone('a');

  // they type whether the service is there or not, like a person who has not noticed yet
  const typed = [];
  let typing = true;
  const typer = async (h, tag, line, min, max) => {
    for (let k = 1; typing; k++) {
      const m = `${tag}${pad4(k)}`;
      await h.edit(k % 7 ? appendTo(line, m) : (doc) => doc.replace(new RegExp(`^(line ${line + 5} .*)$`, 'm'), `$1\ntyped ${m}`), { wait: false });
      typed.push(m);
      await sleep(between(min, max));
    }
  };
  const typers = [typer(ada, 'k', 5, 80, 250), typer(bob, 'j', 8, 120, 400)];

  const agentMarkers = [];
  const agentEdit = async (i) => {
    const m = `g${pad4(i)}`;
    if (i % 2) await a.change('docs/x.md', appendTo(15 + (i % 5), m));
    else await a.change('docs/other.md', (t) => `${t}${m}\n`);
    agentMarkers.push({ m, file: i % 2 ? 'docs/x.md' : 'docs/other.md' });
  };

  const moments = [];
  for (let i = 1; i <= KILLS; i++) {
    const alive = between(300, 3500);
    const dead = between(0, 1500);
    if (i % 3 === 1) { await sleep(alive / 2); await agentEdit(i); await sleep(alive / 2); } else await sleep(alive);
    const s = await b.session().catch(() => null);
    await b.kill('SIGKILL');
    moments.push({ i, aliveMs: alive, deadMs: dead, dirtyAtKill: s?.dirty, typedSoFar: typed.length });
    if (i % 3 === 0) await agentEdit(i);
    await sleep(dead);
    b = await w.startBridge({ ...opts, port });
    assert.equal(b.count('session-recovered'), 1, `restart ${i} recovered the room`);
  }
  await sleep(1200);
  typing = false;
  await Promise.all(typers);
  await ada.settle(20000);
  await bob.settle(20000);
  const main = await quiescent(w, b);

  const missing = typed.filter((m) => count(main, m) === 0);
  const dup = typed.filter((m) => count(main, m) > 1);
  console.log(`# ${KILLS} kills; ${typed.length} keystroke markers typed by two people; unflushed text at the moment of the kill: ${moments.filter((m) => m.dirtyAtKill).length} of ${KILLS}; ${agentMarkers.length} agent commits (some while the service was dead)`);
  console.log(`# missing on main: ${missing.length}; duplicated: ${dup.length}; conflict branches: ${(await w.branches()).length}; reconnects: Ada ${ada.client.connects - 1}, Bob ${bob.client.connects - 1}; commits by the two: ${(await w.logSince('%an')).filter((x) => /Human/.test(x)).length}`);
  assert.deepEqual(missing, [], 'no keystroke marker is missing on main');
  assert.deepEqual(dup, [], 'no keystroke marker is duplicated');
  for (const { m, file } of agentMarkers) assert.equal(count(await w.main(file), m), 1, `agent marker ${m} is on main once`);
  assert.deepEqual(await w.branches(), [], 'no conflict branch was needed');
  assert.equal(ada.text(), main);
  assert.equal(bob.text(), main);
  assert.ok(ada.client.connects - 1 >= KILLS && bob.client.connects - 1 >= KILLS, 'both editors reconnected after every kill');

  // exactly the one room, still the same document
  const st = await b.status();
  assert.equal(st.sessions.length, 1);
  assert.equal(st.sessions[0].docId, docId);
  assert.equal(st.sessions[0].base, await w.tip());
  assert.deepEqual(readdirSync(roomsDir(w)).filter((f) => !f.endsWith('.log')), [], 'no leftover temp files');
  assert.equal(readdirSync(roomsDir(w)).length, 1, 'one room log');
  await w.assertMainOnlyMovedForward();
  assert.equal((await b.close('docs/x.md')).status, 200);
});

test('what the service confirmed is in its room log: the tab is closed, the service killed, and the text still reaches main', async () => {
  const w = await makeWorld('crash-log');
  worlds.push(w);
  const b = await w.startBridge({ debounceMs: 60000 });
  const before = await w.tip();
  const ada = await b.human();
  // typed in small steps, each confirmed, like keystrokes
  for (let k = 1; k <= 40; k++) await ada.edit(appendTo(3, `w${pad4(k)}`));
  const text = ada.text();
  ada.close();
  await b.kill('SIGKILL');
  assert.equal(await w.tip(), before, 'nothing had been committed');
  // a write that was cut off in the middle (cannot happen with one write call per record, but a
  // full disk could leave one): the tail is ignored
  const log = path.join(roomsDir(w), readdirSync(roomsDir(w))[0]);
  appendFileSync(log, Buffer.from([0, 0, 1, 0, 0, 0, 0, 5, 1, 2, 3]));
  const b2 = await w.startBridge({ debounceMs: 60000 });
  const rec = b2.of('session-recovered')[0];
  assert.equal(rec.dirty, true);
  assert.equal(rec.tornBytes, 11);
  const f = await b2.waitFor('flush');
  assert.equal(f.reason, 'recover');
  assert.equal(await w.main('docs/x.md'), text);
  const c = await w.commitInfo(f.commit);
  assert.deepEqual([c.an, c.ae], ['Ada Human', 'ada@humans.test'], 'the author was in the log too');
  for (let k = 1; k <= 40; k++) assert.equal(count(text, `w${pad4(k)}`), 1);
});

// ---- the windows in which a crash leaves the room log and main out of step

async function crashAt(point, name, opts = {}) {
  const w = await makeWorld(name);
  worlds.push(w);
  const b = await w.startBridge({ ...opts, env: { BRIDGE_CRASH_AT: point } });
  const ada = await b.human('docs/x.md', 'Ada Human', 'ada@humans.test');
  return { w, b, ada, restart: () => w.startBridge({ ...opts, port: b.port }) };
}

const humanCommits = async (w) => (await git(w.bare, ['log', '--format=%an', 'main'])).split('\n').filter((x) => x === 'Ada Human').length;

test('crash after the commit was built but before it was pushed: flushed once after the restart', async () => {
  const { w, b, restart } = await crashAt('flush-before-push', 'crash-a', { debounceMs: 500 });
  const before = await w.tip();
  const ada = w.humans[0];
  await ada.edit(replaceLine(3, 'line 03 human edit'));
  assert.equal((await b.exit).signal, 'SIGKILL');
  assert.equal(await w.tip(), before, 'nothing reached main');
  const b2 = await restart();
  assert.equal(await quiescent(w, b2), replaceLine(3, 'line 03 human edit')(DOC));
  assert.equal(await humanCommits(w), 1);
  // the commit that was built before the crash is the one that landed: nothing was built twice
  assert.deepEqual(b2.of('pending-flush-settled').map((e) => [e.commit, e.landed]), [[await w.tip(), true]]);
  assert.equal(b2.count('flush'), 0);
  assert.equal((await w.commitInfo(await w.tip())).an, 'Ada Human');
});

test('crash after the push but before it was recorded: no second commit, later typing on the same line is a normal edit', async () => {
  const { w, b, ada, restart } = await crashAt('flush-pushed-not-recorded', 'crash-b', { debounceMs: 500 });
  await ada.edit(replaceLine(3, 'line 03 human edit'));
  assert.equal((await b.exit).signal, 'SIGKILL');
  assert.equal(await w.main('docs/x.md'), replaceLine(3, 'line 03 human edit')(DOC), 'the push had landed');
  await ada.edit(replaceLine(3, 'line 03 human edit, continued while the service was down'), { wait: false });
  const b2 = await restart();
  assert.equal(await quiescent(w, b2), replaceLine(3, 'line 03 human edit, continued while the service was down')(DOC));
  assert.equal(await humanCommits(w), 2);
  assert.deepEqual(await w.branches(), [], 'not mistaken for a conflict');
});

test('crash right after a fold: the agent\'s lines and the human\'s adjacent lines both survive, no false conflict', async () => {
  const { w, b, ada, restart } = await crashAt('fold-applied', 'crash-c', { debounceMs: 60000 });
  const a = await w.clone('a');
  await ada.edit(replaceLine(4, 'line 04 human, unflushed'));
  const agentCommit = await a.change('docs/x.md', (d) => replaceLine(5, 'line 05 agent')(d).replace('line 08 original\n', 'line 08 original\nagent inserted\n'));
  assert.equal((await b.exit).signal, 'SIGKILL');
  await sleep(300);
  console.log(`# merged text reached the editor before the crash: ${ada.text().includes('line 05 agent')}`);
  assert.equal(await w.tip(), agentCommit);
  // typing right next to the agent's lines while the service is down
  await ada.edit((d) => replaceLine(6, 'line 06 human, typed while the service was down')(replaceLine(4, 'line 04 human, unflushed, and more')(d)).replace('line 08 original\n', 'line 08 original\nhuman inserted\n'), { wait: false });
  const b2 = await restart();
  await until(() => ada.client.synced && !ada.client.pending(), 'the editor to be back');
  await b2.close('docs/x.md');
  const main = await w.main('docs/x.md');
  assert.equal(lineOf(main, 4), 'line 04 human, unflushed, and more');
  assert.equal(lineOf(main, 5), 'line 05 agent');
  assert.equal(lineOf(main, 6), 'line 06 human, typed while the service was down');
  assert.equal(count(main, 'agent inserted\n'), 1, 'the agent line is there once');
  assert.equal(count(main, 'human inserted\n'), 1);
  assert.equal(main.split('\n').length, DOC.split('\n').length + 2);
  assert.equal(ada.text(), main);
  assert.deepEqual(await w.branches(), [], 'no conflict branch');
  // one commit at the restart (what the room log held), one for what was typed while it was down
  assert.equal(await humanCommits(w), 2);
  await w.assertMainOnlyMovedForward();
});
