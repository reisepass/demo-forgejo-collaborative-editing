// The bridge for one repository: humans edit a git-tracked text file in a live room (a Y.Doc held
// by this process) while every other writer keeps using plain git.
//
//   branch main is the only durable truth and only moves forward. The bridge writes to it with an
//   ordinary push from its own bare clone, so every write is a compare-and-swap.
//
// Per room the bridge keeps a base: the commit whose version of the file was last merged into the
// live text. Whatever the live text holds beyond the base text was typed by humans and is not on
// main yet.
//
//   human -> git  (flush)  after a typing pause (debounce) or after maxWait of continuous typing,
//                          the live text is committed on top of main and pushed. A rejected push
//                          means main moved: fetch, fold, build the commit again.
//   git -> human  (fold)   when main moves, three-way merge base / live / main (word by word where
//                          both changed a line) and apply only the difference to the Y.Text, in
//                          one transaction, in the same tick in which the live text was read.
//   clash                  main keeps what landed there, the live text takes main's lines, and the
//                          complete live text from before the merge is committed on a branch
//                          conflict/<user>/<file>-<UTC time> whose parent is the room's base. While
//                          the person is still typing the swap waits for a pause (hold).
//
// A room's document outlives its sessions: when a session ends the text is flushed and the room
// is written down as one snapshot; the next session loads it and folds main in. A browser that
// was away keeps the same document, so what it typed meanwhile merges like any other typing.
//
// All git work and all folds run one at a time (a single queue). Everything a fold changes (the
// text, the base commit, a pending conflict branch) goes to the room log as one record.
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { merge3 } from './shared/merge.js';
import { Git } from './git.js';
import { RoomLog } from './roomlog.js';
import { applyToYText, fromLF, toLF } from './text.js';
import { conflictBranch, conflictMessage, lineCounts, liveEditMessage, orphanMessage } from './commitmsg.js';
import { MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, awarenessMessage, control, decoding, encoding } from './client/protocol.js';
import { makeLogger } from './logger.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');

function fail(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

const samePerson = (a, b) => a.email === b.email && a.name === b.name;

export class Bridge extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.host host adapter (see hosts/base.js)
   * @param {string} o.stateDir durable state of this repository's rooms, outside any working tree
   * @param {number} [o.debounceMs] typing pause after which the live text is committed
   * @param {number} [o.maxWaitMs] longest time unflushed text waits while typing continues
   * @param {number} [o.pollMs] how often main is polled
   * @param {number} [o.holdMs] a fold that would replace lines someone changed waits until nobody
   *   has typed for this long (at most maxWaitMs); 0 swaps at once
   * @param {number} [o.emptyMs] a session ends when no editor is connected for this long
   * @param {number} [o.joinGraceMs] a session no editor ever connected to ends after this long
   * @param {number} [o.idleMs] a session without any edit for this long ends
   */
  constructor(o) {
    super();
    this.host = o.host;
    this.slug = o.host.slug;
    this.stateDir = path.resolve(o.stateDir);
    this.branch = o.branch || 'main';
    this.debounceMs = o.debounceMs ?? 5000;
    this.maxWaitMs = o.maxWaitMs ?? 60000;
    this.pollMs = o.pollMs ?? 2500;
    this.holdMs = o.holdMs ?? 700;
    this.emptyMs = o.emptyMs ?? 30000;
    this.joinGraceMs = o.joinGraceMs ?? 30000;
    this.idleMs = o.idleMs ?? 1800000;
    this.openFreshMs = o.openFreshMs ?? (this.host.kind === 'local' ? 0 : this.pollMs);
    this.identity = { name: o.bridgeName || 'live-bridge', email: o.bridgeEmail || 'live-bridge@localhost' };
    this.log = o.logger || makeLogger('bridge');
    this.git = new Git(path.join(this.stateDir, 'clone.git'), { log: this.log, env: this.host.gitEnv() });
    this.roomsDir = path.join(this.stateDir, 'rooms');
    this.rooms = new Map();
    this.tip = null;
    this.lastFetchAt = 0;
    this.tail = Promise.resolve();
    this.syncQueued = false;
    this.stopped = false;
    this.connSeq = 0;
    this.pushing = 0;
    // commits this bridge is pushing or has pushed lately: the pre-receive hook asks about them
    this.ownPushes = [];
    this.demand = new Map();
    this.demandLimit = o.demandLimit ?? 2;
    this.demandWindowMs = o.demandWindowMs ?? 60000;
    this.counters = { flushes: 0, folds: 0, conflicts: 0, pushRejected: 0, held: 0, wordMerges: 0, demandFlushes: 0 };
    this.recentConflicts = [];
    // nothing is served before the rooms left by an earlier run are recovered
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
  }

  #locked(fn) {
    const run = this.tail.then(fn);
    this.tail = run.catch(() => {});
    return run;
  }

  #event(event, data = {}) {
    this.emit('event', { event, repo: this.slug, at: new Date().toISOString(), ...data });
  }

  // Fault injection for the crash tests: BRIDGE_CRASH_AT=<point> makes the process kill itself there.
  #crashPoint(name) {
    if (process.env.BRIDGE_CRASH_AT === name) process.kill(process.pid, 'SIGKILL');
  }

  get #tracking() { return `refs/remotes/origin/${this.branch}`; }

  async start() {
    mkdirSync(this.roomsDir, { recursive: true, mode: 0o700 });
    await this.git.init(this.host.url);
    await this.#locked(async () => {
      try { this.tip = await this.host.fetch(this.git, this.branch); this.lastFetchAt = Date.now(); } catch (e) {
        this.log.warn(`cannot fetch ${this.branch} from ${this.host.url}: ${e.message}`);
        this.tip = await this.git.resolve(this.#tracking);
      }
      for (const name of readdirSync(this.roomsDir)) {
        if (!name.endsWith('.log')) continue;
        try { await this.#recover(new RoomLog(path.join(this.roomsDir, name))); } catch (e) { this.log.error(`room log ${name}: ${e.message}`); }
      }
    });
    this.poll = setInterval(() => this.#pollOnce(), this.pollMs);
    this.tick = setInterval(() => this.#housekeeping(), Math.max(100, Math.min(1000, Math.floor(Math.min(this.emptyMs, this.joinGraceMs, this.idleMs) / 4))));
    this.log.info(`${this.slug}: serving ${this.host.url} (${this.branch} at ${this.tip}), ${this.rooms.size} room(s) recovered`);
    this.markReady();
    this.#event('ready', { url: this.host.url, branch: this.branch, tip: this.tip, rooms: this.rooms.size, pid: process.pid });
  }

  /** Flushes what is unflushed and stops. Rooms stay on disk and are picked up by the next start. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.poll);
    clearInterval(this.tick);
    await this.#locked(async () => {
      for (const r of this.rooms.values()) {
        clearTimeout(r.timer);
        clearTimeout(r.holdTimer);
        r.holdTimer = null;
        try { if (r.meta.state === 'live' && r.ytext.toString() !== r.baseLF) await this.#flush(r, 'shutdown'); } catch (e) {
          this.log.error(`${r.path}: not flushed at shutdown: ${e.message}`);
        }
        r.log.close();
      }
    });
  }

  // ---------------------------------------------------------------- rooms

  #logFor(file) {
    return new RoomLog(path.join(this.roomsDir, `${sha(file).slice(0, 40)}.log`));
  }

  #newRoom(file, log, meta, doc) {
    const now = Date.now();
    const r = { path: file, log, meta, doc, ytext: doc.getText('text'), awareness: null, conns: new Set(), metaDirty: false, baseRaw: '', baseLF: '', baseBlob: null, mode: '100644', timer: null, holdTimer: null, heldSince: 0, heldTip: null, firstDirtyAt: 0, lastChangeAt: now, openedAt: now, emptySince: 0, everJoined: false, wasDirty: false, failures: 0, typedDuring: null, endQueued: false, flushQueued: false };
    r.awareness = new awarenessProtocol.Awareness(doc);
    r.awareness.setLocalState(null);
    r.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin && origin.isConn) {
        for (const id of added) origin.awareIds.add(id);
        for (const id of removed) origin.awareIds.delete(id);
      }
      const msg = awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(r.awareness, [...added, ...updated, ...removed]));
      for (const c of r.conns) c.send(msg);
    });
    r.ytext.observe((event, tr) => {
      const from = tr.origin;
      if (!from || !from.isConn) return;
      // text typed by a person: remember who, wake an ended session, restart the pause timer
      if (!meta.typedSince.some((p) => samePerson(p, from.user))) { meta.typedSince.push({ name: from.user.name, email: from.user.email }); r.metaDirty = true; }
      if (r.typedDuring && !r.typedDuring.some((p) => samePerson(p, from.user))) r.typedDuring.push({ name: from.user.name, email: from.user.email });
      r.lastChangeAt = Date.now();
      if (meta.state === 'ended') this.#resume(r, 'typing');
      this.#arm(r);
    });
    doc.on('update', (update, origin) => {
      r.log.append(r.metaDirty ? meta : null, update);
      r.metaDirty = false;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      const msg = encoding.toUint8Array(e);
      for (const c of r.conns) if (c !== origin) c.send(msg);
    });
    return r;
  }

  #saveMeta(r) {
    r.log.append(r.meta, null);
    r.metaDirty = false;
  }

  #dirty(r) { return r.ytext.toString() !== r.baseLF; }

  #stateOf(r) {
    const m = r.meta;
    return { path: r.path, docId: m.docId, seq: m.seq, session: m.state, endReason: m.endReason || null, base: m.baseCommit, tip: this.tip, behind: m.baseCommit !== this.tip, dirty: this.#dirty(r), held: !!r.holdTimer, lastCommit: m.lastCommit || null, debounceMs: this.debounceMs, maxWaitMs: this.maxWaitMs };
  }

  #sendState(r) {
    if (!r.conns.size) return;
    const msg = control({ type: 'state', ...this.#stateOf(r) });
    for (const c of r.conns) c.send(msg);
  }

  #tell(r, obj) {
    const msg = control(obj);
    for (const c of r.conns) c.send(msg);
  }

  // Makes `commit` the room's base. Returns false (and changes nothing) when the file is not in it.
  async #loadBase(r, commit) {
    const entry = await this.git.entryAt(commit, r.path);
    if (!entry) return false;
    r.baseRaw = await this.git.blobText(entry.blob);
    r.baseLF = toLF(r.baseRaw);
    r.baseBlob = entry.blob;
    r.mode = entry.mode;
    r.meta.baseCommit = commit;
    return true;
  }

  // Reads a room from its log. Returns null when the log holds nothing usable.
  #load(log) {
    const { meta, updates } = log.read();
    if (!meta || !meta.path || !updates.length) return null;
    const doc = new Y.Doc();
    for (const u of updates) Y.applyUpdate(doc, u, 'load');
    meta.typedSince ||= [];
    meta.pendingConflicts ||= [];
    for (const c of meta.pendingConflicts) delete c.pushing;
    meta.conflicts ||= [];
    return this.#newRoom(meta.path, log, meta, doc);
  }

  // A commit was built and maybe pushed when the service died. The git process that pushes
  // outlives a killed service, so "not on main" can mean "not on main yet": the same commit is
  // pushed again, which settles it either way. Has to run before the room's base is used.
  async #settlePendingFlush(r) {
    const m = r.meta;
    if (!m.pendingFlush) return;
    const c = m.pendingFlush.commit;
    let landed = !!this.tip && await this.git.isAncestor(c, this.tip);
    for (let i = 0; !landed && i < 6 && await this.git.resolve(c); i++) {
      const res = await this.#push(c, `refs/heads/${this.branch}`);
      const tip = await this.host.fetch(this.git, this.branch).catch(() => null);
      if (tip) this.tip = tip;
      if (res.ok || (tip && await this.git.isAncestor(c, tip))) { landed = true; break; }
      // main moved to something else: this commit can never land there any more
      if (/non-fast-forward|fetch first/.test(res.reason || '')) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (landed) {
      m.baseCommit = c;
      m.lastCommit = c;
    } else {
      m.typedSince = [...m.pendingFlush.authors, ...m.typedSince.filter((p) => !m.pendingFlush.authors.some((q) => samePerson(p, q)))];
    }
    this.#event('pending-flush-settled', { path: r.path, commit: c, landed });
    m.pendingFlush = null;
  }

  async #recover(log) {
    const { meta } = log.read();
    if (!meta || meta.state !== 'live') return;
    const r = this.#load(log);
    if (!r) return;
    const m = r.meta;
    await this.#settlePendingFlush(r);
    if (!await this.#loadBase(r, m.baseCommit)) { this.log.error(`${r.path}: not found in the recorded base ${m.baseCommit}; room left on disk`); return; }
    this.rooms.set(r.path, r);
    this.#saveMeta(r);
    await this.#pushPendingConflicts(r);
    this.#event('session-recovered', { path: r.path, base: m.baseCommit, dirty: this.#dirty(r), records: log.records, tornBytes: log.torn });
    try {
      await this.#fold(r, this.tip);
      if (this.rooms.has(r.path) && this.#dirty(r)) await this.#flush(r, 'recover');
    } catch (e) {
      this.log.error(`${r.path}: reconcile after restart: ${e.message}`);
      this.#arm(r);
    }
  }

  static checkPath(file) {
    if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\0') || file.split('/').some((p) => p === '..' || p === '' || p === '.')) throw fail('BAD_PATH', 'the path must be relative to the repository root');
  }

  /** The live room of `file`, starting a session when there is none. Runs in the queue. */
  async #open(file) {
    Bridge.checkPath(file);
    let r = this.rooms.get(file);
    if (r && r.meta.state === 'live') return r;
    if (r) {
      this.#resume(r, 'open');
      await this.#sync().catch((e) => this.log.warn(`${file}: main not fetched at open: ${e.message}`));
      if (!this.rooms.has(file)) throw fail('NO_FILE', `${file} is not a regular file on ${this.branch}`, 404);
      return r;
    }
    if (!this.tip || Date.now() - this.lastFetchAt > this.openFreshMs) {
      await this.#sync().catch((e) => { if (!this.tip) throw e; this.log.warn(`${file}: main not fetched at open: ${e.message}`); });
    }
    if (!this.tip) throw fail('NO_MAIN', `${this.host.url} has no branch ${this.branch}`, 404);
    const log = this.#logFor(file);
    if (log.exists()) {
      r = this.#load(log);
      if (r) await this.#settlePendingFlush(r);
      if (r && !await this.#loadBase(r, r.meta.baseCommit)) {
        this.log.error(`${file}: the stored room names a base (${r.meta.baseCommit}) without this file; starting over from ${this.branch}`);
        r.awareness.destroy();
        r = null;
      }
    }
    if (r) {
      const m = r.meta;
      m.state = 'live';
      m.seq += 1;
      m.endReason = null;
      this.rooms.set(file, r);
      this.#saveMeta(r);
      await this.#fold(r, this.tip);
      if (!this.rooms.has(file)) throw fail('NO_FILE', `${file} is not a regular file on ${this.branch}`, 404);
      this.log.info(`${file}: session ${m.seq} opened on the stored document at ${m.baseCommit}`);
      this.#event('session-open', { path: file, base: m.baseCommit, seq: m.seq, stored: true });
      if (this.#dirty(r)) this.#arm(r);
      return r;
    }
    const base = this.tip;
    const entry = await this.git.entryAt(base, file);
    if (!entry || !/^100/.test(entry.mode)) throw fail('NO_FILE', `${file} is not a regular file on ${this.branch}`, 404);
    const bytes = await this.git.blobBytes(entry.blob);
    const raw = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(raw, 'utf8').equals(bytes)) throw fail('NOT_TEXT', `${file} is not UTF-8 text`, 415);
    const doc = new Y.Doc();
    doc.getText('text').insert(0, toLF(raw));
    const meta = { v: 1, path: file, docId: randomBytes(12).toString('hex'), baseCommit: base, state: 'live', seq: 1, typedSince: [], pendingFlush: null, pendingConflicts: [], conflicts: [], lastCommit: null, endReason: null, createdAt: new Date().toISOString() };
    log.compact(meta, Y.encodeStateAsUpdate(doc));
    r = this.#newRoom(file, log, meta, doc);
    r.baseRaw = raw;
    r.baseLF = toLF(raw);
    r.baseBlob = entry.blob;
    r.mode = entry.mode;
    this.rooms.set(file, r);
    this.log.info(`${file}: session 1 opened at ${base}`);
    this.#event('session-open', { path: file, base, seq: 1, stored: false });
    return r;
  }

  // An ended session whose document is still in memory goes live again. Synchronous: it is called
  // from inside the transaction of the keystroke that woke it.
  #resume(r, why) {
    const m = r.meta;
    if (m.state === 'live') return;
    m.state = 'live';
    m.seq += 1;
    m.endReason = null;
    r.metaDirty = true;
    r.openedAt = Date.now();
    r.lastChangeAt = Date.now();
    r.everJoined = r.conns.size > 0;
    r.emptySince = 0;
    this.log.info(`${r.path}: session ${m.seq} started (${why})`);
    this.#event('session-open', { path: r.path, base: m.baseCommit, seq: m.seq, stored: true, why });
    queueMicrotask(() => { if (r.metaDirty) this.#saveMeta(r); this.#sendState(r); this.poke('resume'); });
  }

  /** For the editor's first paint: the document as one Yjs update, opening the room if needed. */
  async state(file) {
    await this.ready;
    const r = await this.#locked(() => this.#open(file));
    return { docId: r.meta.docId, update: Y.encodeStateAsUpdate(r.doc), ...this.#stateOf(r) };
  }

  // ---------------------------------------------------------------- connections

  /**
   * A signed-in editor joins the room of `file`.
   * @param {string} file
   * @param {{name: string, email: string}} user
   * @param {(data: Uint8Array) => void} send
   * @param {{docId?: string, readOnly?: boolean}} [o] the document the editor already holds, if
   *   any; readOnly: the person may watch but nothing they send changes the text
   */
  async connect(file, user, send, { docId, readOnly = false } = {}) {
    Bridge.checkPath(file);
    await this.ready;
    let r = this.rooms.get(file);
    if (!r) r = await this.#locked(() => this.#open(file));
    const conn = { id: ++this.connSeq, isConn: true, user: { name: user.name, email: user.email }, send, room: r, received: 0, awareIds: new Set(), open: true, stale: false, readOnly };
    if (docId && docId !== r.meta.docId) {
      // the editor holds a document this service no longer has (the file was removed and came back,
      // or the state directory is new): it has to start over from the current one
      conn.stale = true;
      send(control({ type: 'reset', docId: r.meta.docId }));
      return conn;
    }
    r.conns.add(conn);
    r.everJoined = true;
    r.emptySince = 0;
    send(control({ type: 'hello', you: conn.user, access: readOnly ? 'read' : 'write', conflicts: r.meta.conflicts.slice(-5), ...this.#stateOf(r) }));
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, r.doc);
    send(encoding.toUint8Array(e));
    const states = r.awareness.getStates();
    if (states.size) send(awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(r.awareness, [...states.keys()])));
    this.#event('join', { path: file, user: conn.user.name, email: conn.user.email, conns: r.conns.size, ...(readOnly ? { readOnly: true } : {}) });
    return conn;
  }

  /** One websocket frame from an editor. Synchronous: a keystroke is in the room log when this returns. */
  receive(conn, data) {
    const r = conn.room;
    if (!conn.open || conn.stale || !r.doc) return;
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      if (conn.readOnly && decoding.peekVarUint(d) !== syncProtocol.messageYjsSyncStep1) {
        // a reader may ask for the text (step 1); whatever it sends as text is confirmed and dropped
        conn.received += 1;
        conn.send(control({ type: 'ack', n: conn.received }));
        return;
      }
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(d, e, r.doc, conn);
      if (encoding.length(e) > 1) conn.send(encoding.toUint8Array(e));
      if (kind !== syncProtocol.messageYjsSyncStep1) {
        conn.received += 1;
        conn.send(control({ type: 'ack', n: conn.received }));
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(r.awareness, decoding.readVarUint8Array(d), conn);
    } else if (type === MSG_CONTROL) {
      let msg = null;
      try { msg = JSON.parse(decoding.readVarString(d)); } catch { /* ignored */ }
      if (msg && msg.type === 'resume' && r.meta.state === 'ended' && !conn.readOnly) this.#resume(r, 'requested');
    }
  }

  disconnect(conn) {
    if (!conn.open) return;
    conn.open = false;
    const r = conn.room;
    if (!r.conns.delete(conn)) return;
    if (r.awareness && conn.awareIds.size) awarenessProtocol.removeAwarenessStates(r.awareness, [...conn.awareIds], null);
    this.#event('leave', { path: r.path, user: conn.user.name, conns: r.conns.size });
  }

  // (Re)starts the flush timer: debounce after the last change, capped at maxWait after the first.
  #arm(r) {
    if (this.stopped || r.meta.state !== 'live') return;
    clearTimeout(r.timer);
    r.timer = null;
    const dirty = this.#dirty(r);
    if (dirty !== r.wasDirty) { r.wasDirty = dirty; this.#sendState(r); }
    if (!dirty) { r.firstDirtyAt = 0; return; }
    // a flush that is queued or running arms the timer again when it is through, and so does a
    // fold that is held back for a typing pause (a flush cannot overtake it); keystrokes that
    // arrive meanwhile must not queue one flush each
    if (r.flushQueued || r.holdTimer) return;
    const now = Date.now();
    if (!r.firstDirtyAt) r.firstDirtyAt = now;
    const due = Math.min(r.lastChangeAt + this.debounceMs, r.firstDirtyAt + this.maxWaitMs);
    r.timer = setTimeout(() => this.#timedFlush(r, due >= r.firstDirtyAt + this.maxWaitMs ? 'max-wait' : 'debounce'), Math.max(0, due - now));
  }

  #timedFlush(r, reason) {
    r.timer = null;
    r.flushQueued = true;
    this.#locked(() => this.#flush(r, reason)).then(() => {
      r.failures = 0;
      r.flushQueued = false;
      // while a clash is held back the fold arms the timer when it is through
      if (!r.holdTimer) this.#arm(r);
    }, (e) => {
      r.flushQueued = false;
      r.failures += 1;
      this.log.error(`${r.path}: flush failed (${e.message}); main is untouched, retrying`);
      this.#event('error', { path: r.path, what: 'flush', message: e.message });
      // the people in the room see why their text is not on main yet (the host refused it, or is away)
      this.#tell(r, { type: 'notice', kind: 'flush-failed', message: e.message, failures: r.failures, at: new Date().toISOString() });
      if (!this.stopped && this.rooms.has(r.path)) r.timer = setTimeout(() => this.#timedFlush(r, 'retry'), Math.min(30000, 1000 * r.failures));
    });
  }

  // ---------------------------------------------------------------- git -> human

  // Every write to the host goes through here. `author` is the person whose text the commit
  // carries: a host that knows people (Forgejo) pushes with that person's own credentials.
  async #push(commit, ref, author = null) {
    const toMain = ref === `refs/heads/${this.branch}`;
    if (toMain) this.pushing += 1;
    this.ownPushes.push(commit);
    if (this.ownPushes.length > 200) this.ownPushes.shift();
    try { return await this.host.push(this.git, commit, ref, { author }); } finally { if (toMain) this.pushing -= 1; }
  }

  // The polling fallback, and the only way to notice new commits on a host that cannot call back.
  // The network part runs outside the queue, so a slow host never delays a flush; one poll at a time.
  async #pollOnce() {
    // a fetch in front of a waiting push would only delay it; the push itself says whether main moved
    if (this.pollBusy || this.stopped || this.pushing) return;
    this.pollBusy = true;
    try {
      const tip = await this.host.fetch(this.git, this.branch);
      this.lastFetchAt = Date.now();
      this.lastSyncError = null;
      if (tip && tip !== this.tip) this.poke('poll', tip);
      else if ([...this.rooms.values()].some((r) => r.meta.state === 'live' && r.meta.baseCommit !== this.tip && !r.holdTimer)) this.poke('poll', this.tip);
    } catch (e) {
      const msg = `cannot reach ${this.host.url} (poll): ${e.message}`;
      if (this.lastSyncError !== msg) this.log.warn(msg);
      this.lastSyncError = msg;
    } finally { this.pollBusy = false; }
  }

  /**
   * Folds main into every live room. Fetches first unless `fetched` (a commit just fetched by the
   * poll) is given. Returns true when main moved. Runs in the queue.
   */
  async #sync(fetched = null) {
    let tip = fetched;
    // a poll result can be older than a commit the bridge pushed meanwhile
    if (tip && this.tip && tip !== this.tip && await this.git.isAncestor(tip, this.tip)) tip = this.tip;
    if (!tip) { tip = await this.host.fetch(this.git, this.branch); this.lastFetchAt = Date.now(); }
    if (!tip) return false;
    const moved = tip !== this.tip;
    this.tip = tip;
    for (const r of [...this.rooms.values()]) {
      if (r.meta.state !== 'live') continue;
      try {
        await this.#pushPendingConflicts(r);
        await this.#fold(r, tip);
      } catch (e) {
        this.log.error(`${r.path}: fold of ${tip} failed: ${e.message}`);
        this.#event('error', { path: r.path, what: 'fold', message: e.message });
      }
    }
    return moved;
  }

  /** Something says main may have moved (hook, webhook, poll). Coalesced; never throws. */
  poke(reason = 'poke', fetched = null) {
    if (this.syncQueued || this.stopped) return;
    this.syncQueued = true;
    this.#locked(async () => {
      this.syncQueued = false;
      await this.#sync(fetched);
    }).catch((e) => {
      this.syncQueued = false;
      const msg = `cannot reach ${this.host.url} (${reason}): ${e.message}`;
      if (this.lastSyncError !== msg) this.log.warn(msg);
      this.lastSyncError = msg;
    });
  }

  #author(r) {
    return r.meta.typedSince[0] || this.identity;
  }

  // Builds (locally) the commit that keeps the complete live text of a room that is about to lose
  // clashing lines to main.
  async #conflictCommit(r, live, mainCommit) {
    const m = r.meta;
    const author = this.#author(r);
    const text = fromLF(live, r.baseRaw);
    const commit = await this.git.commitFile({
      parent: m.baseCommit,
      file: r.path,
      mode: r.mode,
      text,
      author,
      committer: this.identity,
      message: conflictMessage(r.path, r.baseRaw, text, mainCommit, m.typedSince.slice(1)),
    });
    return { live, commit, author, branch: conflictBranch(author.name, r.path) };
  }

  async #pushPendingConflicts(r) {
    const m = r.meta;
    for (const c of [...m.pendingConflicts]) {
      if (c.pushing) continue;
      c.pushing = true;
      let res;
      try { res = await this.#push(c.commit, `refs/heads/${c.branch}`, { name: c.user, email: c.email }); } catch (e) { res = { ok: false, reason: e.message }; } finally { delete c.pushing; }
      if (!res.ok) {
        this.log.error(`${r.path}: conflict branch ${c.branch} not pushed yet (${res.reason}); it is kept in the bridge clone as ${c.commit}`);
        if (!c.reported) { this.#event('conflict', { ...c, pushed: false }); this.#tell(r, { type: 'conflict', ...c, pushed: false }); }
        c.reported = true;
        continue;
      }
      m.pendingConflicts = m.pendingConflicts.filter((x) => x !== c);
      const done = { ...c, pushed: true };
      delete done.reported;
      m.conflicts.push(done);
      if (m.conflicts.length > 20) m.conflicts.shift();
      this.recentConflicts.push(done);
      if (this.recentConflicts.length > 500) this.recentConflicts.shift();
      this.#saveMeta(r);
      this.log.warn(`${r.path}: clash with ${c.mainCommit}; main's lines were taken, the live text of ${c.user} is on branch ${c.branch} (${c.commit})`);
      this.#event('conflict', done);
      this.#tell(r, { type: 'conflict', ...done });
    }
  }

  /**
   * Brings the room up to `tip`: merges main's version of the file into the live text and
   * advances the base. Returns false when it was not done now (a clash is held back, or the
   * session is not live).
   */
  async #fold(r, tip) {
    const m = r.meta;
    if (!tip || !this.rooms.has(r.path) || m.state !== 'live') return false;
    if (m.baseCommit === tip) return true;

    const entry = await this.git.entryAt(tip, r.path);
    if (!entry) {
      // the file is gone on main: keep the live text on a conflict branch and drop the room
      await this.#fileGone(r, tip);
      return true;
    }
    const remoteRaw = entry.blob === r.baseBlob ? r.baseRaw : await this.git.blobText(entry.blob);
    const remote = toLF(remoteRaw);
    r.mode = entry.mode;
    if (remote === r.baseLF) {
      r.baseRaw = remoteRaw;
      r.baseBlob = entry.blob;
      m.baseCommit = tip;
      r.heldSince = 0;
      this.#saveMeta(r);
      this.#sendState(r);
      return true;
    }

    const t0 = Date.now();
    const touching = await this.git.commitsTouching(m.baseCommit, tip, r.path);
    const by = touching[0] || { commit: tip, ...(await this.git.authorOf(tip)) };
    let saved = null;
    let conflicts = [];
    let changed = false;
    let wasDirty = false;
    let wordMerges = 0;
    for (let tries = 0; ; tries++) {
      // from here to the transaction: no await, so the merge is made against exactly the live text
      const live = r.ytext.toString();
      const mg = merge3(r.baseLF, live, remote, { words: true });
      if (mg.conflicts.length && this.holdMs > 0 && !this.stopped) {
        const now = Date.now();
        const quietFor = now - r.lastChangeAt;
        if (!r.heldSince) r.heldSince = now;
        const holdLeft = r.heldSince + this.maxWaitMs - now;
        if (quietFor < this.holdMs && holdLeft > 0) {
          // someone is typing: main's version of their lines waits for a pause
          if (r.heldTip !== tip) { this.counters.held += 1; this.#event('fold-held', { path: r.path, commit: tip }); }
          r.heldTip = tip;
          clearTimeout(r.holdTimer);
          r.holdTimer = setTimeout(() => { r.holdTimer = null; this.poke('hold', this.tip); }, Math.max(5, Math.min(this.holdMs - quietFor, holdLeft)) + 5);
          return false;
        }
      }
      if (mg.conflicts.length && (!saved || saved.live !== live)) {
        if (tries > 40) throw new Error('the live text never held still long enough to save a conflict copy');
        saved = await this.#conflictCommit(r, live, by.commit);
        continue;
      }
      conflicts = mg.conflicts;
      wordMerges = mg.wordMerges || 0;
      wasDirty = live !== r.baseLF;
      if (conflicts.length) {
        m.pendingConflicts.push({ path: r.path, user: saved.author.name, email: saved.author.email, branch: saved.branch, commit: saved.commit, parent: m.baseCommit, mainCommit: by.commit, mainAuthor: by.name, mainTip: tip, at: new Date().toISOString(), lines: conflicts.map((c) => c.line) });
      }
      changed = mg.text !== live;
      m.baseCommit = tip;
      r.baseRaw = remoteRaw;
      r.baseLF = remote;
      r.baseBlob = entry.blob;
      r.heldSince = 0;
      r.heldTip = null;
      clearTimeout(r.holdTimer);
      r.holdTimer = null;
      // merged text, new base and the pending conflict branch go to the log as one record
      r.metaDirty = true;
      if (changed) r.doc.transact(() => applyToYText(r.ytext, live, mg.text), { type: 'fold', commit: by.commit, author: by.name });
      if (r.metaDirty) this.#saveMeta(r);
      this.#crashPoint('fold-applied');
      break;
    }
    this.counters.folds += 1;
    this.counters.wordMerges += wordMerges;
    if (conflicts.length) this.counters.conflicts += 1;
    this.#event('fold', { path: r.path, commit: tip, by: by.commit, author: by.name, changed, dirty: wasDirty, conflicts: conflicts.length, wordMerges, ms: Date.now() - t0 });
    if (changed || conflicts.length) this.#tell(r, { type: 'notice', kind: 'fold', commit: by.commit, author: { name: by.name, email: by.email }, commits: touching.map((c) => c.commit), tip, changed, conflicts: conflicts.length, at: new Date().toISOString() });
    r.wasDirty = this.#dirty(r);
    this.#sendState(r);
    if (conflicts.length) {
      // The editors learn the branch name with the swap. The branch itself is a new ref nobody else
      // writes to and its commit is already in the room log, so its push does not have to hold up
      // the queue (a new branch takes a remote host seconds); it is retried with every sync.
      const c = m.pendingConflicts.at(-1);
      this.#tell(r, { type: 'conflict', ...c, pushed: false });
      this.#pushPendingConflicts(r).catch((e) => this.log.error(`${r.path}: conflict branch: ${e.message}`));
    }
    if (r.wasDirty && !r.timer) this.#arm(r);
    return true;
  }

  async #fileGone(r, tip) {
    const m = r.meta;
    const live = r.ytext.toString();
    if (live !== r.baseLF) {
      const saved = await this.#conflictCommit(r, live, tip);
      m.pendingConflicts.push({ path: r.path, user: saved.author.name, email: saved.author.email, branch: saved.branch, commit: saved.commit, parent: m.baseCommit, mainCommit: tip, mainAuthor: (await this.git.authorOf(tip)).name, mainTip: tip, at: new Date().toISOString(), lines: [], why: 'file removed on main' });
      this.#saveMeta(r);
      await this.#pushPendingConflicts(r);
    }
    if (m.pendingConflicts.length) throw new Error('the file was removed on main and the conflict branch could not be pushed; room kept');
    const author = await this.git.authorOf(tip);
    this.#tell(r, { type: 'removed', commit: tip, author, branch: m.conflicts.at(-1)?.mainCommit === tip ? m.conflicts.at(-1).branch : null });
    this.#forget(r, 'file-removed-on-main');
  }

  #forget(r, reason) {
    clearTimeout(r.timer);
    clearTimeout(r.holdTimer);
    for (const c of r.conns) c.stale = true;
    r.conns.clear();
    this.rooms.delete(r.path);
    r.log.remove();
    r.awareness.destroy();
    r.doc.destroy();
    this.log.info(`${r.path}: room dropped (${reason})`);
    this.#event('session-close', { path: r.path, reason, commit: null, base: r.meta.baseCommit });
  }

  // ---------------------------------------------------------------- human -> git

  /**
   * Commits the live text on top of main and pushes it. Returns the commit, or null when there
   * was nothing to flush. Runs in the queue.
   */
  async #flush(r, reason) {
    const m = r.meta;
    if (!this.rooms.has(r.path) || m.state !== 'live') return null;
    let made = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!this.tip) throw new Error(`${this.branch} is not known yet`);
      if (m.baseCommit !== this.tip) {
        const folded = await this.#fold(r, this.tip);
        if (!folded && r.holdTimer) return null; // a held fold comes first; it re-arms the flush when it is through
        if (!this.rooms.has(r.path)) return null;
        if (!folded || m.baseCommit !== this.tip) throw new Error('main could not be merged into the live text first');
      }
      const live = r.ytext.toString();
      if (live === r.baseLF) {
        if (m.typedSince.length) { m.typedSince = []; this.#saveMeta(r); }
        break;
      }
      const t0 = Date.now();
      const parent = this.tip;
      const authors = m.typedSince.length ? m.typedSince.slice() : [this.identity];
      const text = fromLF(live, r.baseRaw);
      const before = r.baseRaw;
      r.typedDuring = [];
      let commit;
      try {
        commit = await this.git.commitFile({ parent, file: r.path, mode: r.mode, text, author: authors[0], committer: this.identity, message: liveEditMessage(r.path, before, text, authors.slice(1)) });
      } catch (e) { r.typedDuring = null; throw e; }
      // whoever typed while the commit was built has text that is not in it
      m.typedSince = r.typedDuring;
      r.typedDuring = null;
      m.pendingFlush = { commit, hash: sha(live), authors };
      this.#saveMeta(r);
      this.#crashPoint('flush-before-push');
      const res = await this.#push(commit, `refs/heads/${this.branch}`, authors[0] === this.identity ? null : authors[0]);
      // A push can fail on this side after the host took it (a dropped connection). Whether the
      // commit is on main is asked from the host before anything is concluded.
      let landedAt = null;
      let fetched = null;
      if (!res.ok) {
        fetched = await this.host.fetch(this.git, this.branch).catch(() => null);
        if (fetched) this.lastFetchAt = Date.now();
        if (fetched && await this.git.isAncestor(commit, fetched)) landedAt = fetched;
      }
      if (res.ok || landedAt) {
        this.#crashPoint('flush-pushed-not-recorded');
        const counts = lineCounts(before, text);
        const dirtyMs = r.firstDirtyAt ? Date.now() - r.firstDirtyAt : null;
        if (res.ok) this.tip = commit;
        m.baseCommit = commit;
        m.lastCommit = commit;
        m.lastAuthor = `${authors[0].name} <${authors[0].email}>`;
        r.baseRaw = text;
        r.baseLF = live;
        r.baseBlob = null;
        m.pendingFlush = null;
        this.#saveMeta(r);
        r.firstDirtyAt = 0;
        this.counters.flushes += 1;
        this.#event('flush', { path: r.path, commit, parent, author: `${authors[0].name} <${authors[0].email}>`, coAuthors: authors.slice(1).map((p) => p.email), reason, attempt, ...counts, dirtyMs, ms: Date.now() - t0, ...(res.ok ? {} : { pushReportedFailure: res.reason }) });
        this.#tell(r, { type: 'notice', kind: 'saved', commit, author: authors[0], at: new Date().toISOString() });
        if (r.log.records > 400) r.log.compact(m, Y.encodeStateAsUpdate(r.doc));
        if (landedAt) await this.#sync(landedAt);
        else for (const o of [...this.rooms.values()]) if (o !== r) await this.#fold(o, commit).catch((e) => this.log.error(`${o.path}: ${e.message}`));
        made = commit;
        break;
      }
      m.typedSince = [...authors.filter((p) => p !== this.identity), ...m.typedSince.filter((p) => !authors.some((q) => samePerson(p, q)))];
      m.pendingFlush = null;
      this.#saveMeta(r);
      this.counters.pushRejected += 1;
      this.#event('push-rejected', { path: r.path, commit, reason: res.reason, attempt });
      const moved = await this.#sync(fetched);
      if (!moved) throw new Error(`push to ${this.branch} was refused and ${this.branch} did not move: ${res.reason} ${String(res.stderr).trim()}`);
    }
    r.wasDirty = this.#dirty(r);
    this.#sendState(r);
    this.#arm(r);
    return made;
  }

  // ---------------------------------------------------------------- demand flush (pre-receive)

  /**
   * Asked by the host's pre-receive hook while somebody's push to main waits. If the push touches
   * a file whose room holds text that is not on main yet, that text is committed first and the
   * push is turned away once, so the pusher rebases onto it like onto any other commit. Bounded
   * per push and file, so continuous typing cannot keep a pusher out.
   * @param {{new: string, paths: string[], pusher?: string, pushId?: string}} q
   * @returns {Promise<{allow: boolean, message?: string, own?: boolean, bound?: boolean}>}
   */
  async preflush({ new: neu, paths = [], pusher = '', pushId = '' }) {
    // the bridge's own push: answered without the queue, which is waiting for exactly this push
    if (this.ownPushes.includes(neu)) return { allow: true, own: true };
    const hit = [...this.rooms.values()].filter((r) => r.meta.state === 'live' && paths.includes(r.path));
    const dirty = hit.filter((r) => this.#dirty(r));
    if (!dirty.length) return { allow: true };
    const decided = (decision, extra = {}) => this.#event('preflush', { paths: dirty.map((r) => r.path), pusher, commit: neu, decision, ...extra });
    const now = Date.now();
    for (const [k, times] of this.demand) if (!times.some((x) => now - x < this.demandWindowMs)) this.demand.delete(k);
    const todo = [];
    for (const r of dirty) {
      const key = `${pushId || pusher}\0${r.path}`;
      const recent = (this.demand.get(key) || []).filter((t) => now - t < this.demandWindowMs);
      this.demand.set(key, recent);
      if (recent.length < this.demandLimit) todo.push({ r, key });
    }
    if (!todo.length) {
      // this pusher was turned away often enough: the push lands and the fold merges it into the room
      decided('bound');
      return { allow: true, bound: true };
    }
    const made = [];
    await this.#locked(async () => {
      for (const { r } of todo) { const c = await this.#flush(r, 'demand'); if (c) made.push({ r, commit: c }); }
    });
    // nothing was committed (the text went back to main's, or a clash is held for a typing pause):
    // the push goes on, and git itself turns it away if main moved under it
    if (!made.length) { decided('clean'); return { allow: true }; }
    for (const { key } of todo) this.demand.set(key, [...(this.demand.get(key) || []), now]);
    this.counters.demandFlushes += 1;
    const lines = made.map(({ r, commit }) => `${r.path} is being edited live by ${r.meta.lastAuthor || 'someone'}; their text was just saved to ${this.branch} as ${commit}.`);
    lines.push('Your push was not applied. Run "git pull --rebase" (or "git pull") and push again.');
    decided('rejected', { flushed: made.map((m) => m.commit), ms: Date.now() - now });
    return { allow: false, message: lines.join('\n') };
  }

  // ---------------------------------------------------------------- session lifecycle

  // Ends a session: what the live text holds is flushed and the room written down as a snapshot.
  // Refuses, and keeps the session, when the text cannot be put on main or someone keeps typing.
  async #end(r, reason) {
    const m = r.meta;
    if (!this.rooms.has(r.path) || m.state !== 'live') return { ok: true, path: r.path, already: true };
    clearTimeout(r.timer);
    r.timer = null;
    let last = null;
    try {
      for (let i = 0; i < 5; i++) {
        await this.#sync().catch((e) => { if (this.#dirty(r)) throw e; });
        if (!this.rooms.has(r.path)) return { ok: true, path: r.path, reason: 'file-removed-on-main' };
        const made = await this.#flush(r, 'session-end');
        if (made) last = made;
        if (!this.#dirty(r) && !r.holdTimer) break;
      }
      clearTimeout(r.timer);
      r.timer = null;
      if (this.#dirty(r)) throw new Error('the text kept changing during the final flush');
      if (m.pendingConflicts.length) throw new Error('a conflict branch is not pushed yet');
    } catch (e) {
      this.#arm(r);
      throw fail('NOT_FLUSHED', `${r.path}: session kept, the final flush failed: ${e.message}`, 409);
    }
    m.state = 'ended';
    m.endReason = reason;
    m.endedAt = new Date().toISOString();
    r.log.compact(m, Y.encodeStateAsUpdate(r.doc));
    this.log.info(`${r.path}: session ${m.seq} ended (${reason})`);
    this.#event('session-close', { path: r.path, reason, commit: last, base: m.baseCommit, seq: m.seq });
    this.#sendState(r);
    if (!r.conns.size) this.#unload(r);
    return { ok: true, path: r.path, reason, commit: last };
  }

  // Frees an ended room nobody is looking at. Its snapshot stays on disk.
  #unload(r) {
    if (r.meta.state !== 'ended' || r.conns.size) return;
    this.rooms.delete(r.path);
    r.log.close();
    r.awareness.destroy();
    r.doc.destroy();
  }

  #housekeeping() {
    const now = Date.now();
    for (const r of [...this.rooms.values()]) {
      if (r.meta.state !== 'live') { if (!r.conns.size) this.#unload(r); continue; }
      let reason = null;
      if (r.conns.size) r.emptySince = 0;
      else {
        if (!r.emptySince) r.emptySince = now;
        if (r.everJoined && now - r.emptySince >= this.emptyMs) reason = 'no-participants';
        else if (!r.everJoined && now - r.openedAt >= this.joinGraceMs) reason = 'nobody-joined';
      }
      if (!reason && now - Math.max(r.lastChangeAt, r.openedAt) >= this.idleMs) reason = 'idle';
      if (!reason || r.endQueued) continue;
      r.endQueued = true;
      this.#locked(() => this.#end(r, reason)).catch((e) => this.log.error(e.message)).finally(() => { r.endQueued = false; });
    }
  }

  /** Ends the session of `file` on request. */
  close(file) {
    const r = this.rooms.get(file);
    if (!r || r.meta.state !== 'live') throw fail('NO_SESSION', `no session for ${file}`, 404);
    return this.#locked(() => this.#end(r, 'closed-by-request'));
  }

  /**
   * Text of an editor whose document this service no longer has: kept whole on a conflict branch
   * on top of main, never merged.
   */
  orphan(file, user, text) {
    Bridge.checkPath(file);
    return this.#locked(async () => {
      await this.#sync().catch(() => {});
      if (!this.tip) throw fail('NO_MAIN', `${this.host.url} has no branch ${this.branch}`, 404);
      const entry = await this.git.entryAt(this.tip, file);
      const raw = entry ? await this.git.blobText(entry.blob) : '';
      if (toLF(raw) === toLF(text)) return { ok: true, same: true };
      const branch = conflictBranch(user.name, file);
      const commit = await this.git.commitFile({ parent: this.tip, file, mode: entry?.mode || '100644', text: fromLF(toLF(text), raw), author: user, committer: this.identity, message: orphanMessage(file, this.tip) });
      const res = await this.#push(commit, `refs/heads/${branch}`, user);
      if (!res.ok) throw fail('NOT_PUSHED', `the copy could not be pushed: ${res.reason}`, 502);
      const done = { path: file, user: user.name, email: user.email, branch, commit, parent: this.tip, mainCommit: this.tip, at: new Date().toISOString(), lines: [], why: 'editor document no longer on the service', pushed: true };
      this.recentConflicts.push(done);
      this.#event('conflict', done);
      return { ok: true, branch, commit };
    });
  }

  /** Regular files on main, for the file tree. */
  async files() {
    if (!this.tip) return { tip: null, files: [] };
    return { tip: this.tip, files: (await this.git.listFiles(this.tip)).map((f) => f.path) };
  }

  status() {
    return {
      repo: this.slug,
      kind: this.host.kind,
      branch: this.branch,
      tip: this.tip,
      counters: this.counters,
      settings: { debounceMs: this.debounceMs, maxWaitMs: this.maxWaitMs, holdMs: this.holdMs, pollMs: this.pollMs },
      sessions: [...this.rooms.values()].map((r) => ({
        path: r.path,
        docId: r.meta.docId,
        state: r.meta.state,
        seq: r.meta.seq,
        base: r.meta.baseCommit,
        behind: r.meta.baseCommit !== this.tip,
        dirty: this.#dirty(r),
        held: !!r.holdTimer,
        editors: [...r.conns].map((c) => c.user),
        typedSince: r.meta.typedSince,
        conflicts: r.meta.conflicts,
        pendingConflicts: r.meta.pendingConflicts,
        logRecords: r.log.records,
        text: undefined,
      })),
      conflicts: this.recentConflicts,
    };
  }

  /** The live text of a room, for tests and diagnostics. Null when the room is not in memory. */
  liveText(file) {
    const r = this.rooms.get(file);
    return r ? r.ytext.toString() : null;
  }
}
