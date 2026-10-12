// A person in a room, without a browser: the same client code the editor uses, a Y.Doc and edits
// applied to its Y.Text as small targeted changes (the way an editor would).
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { LiveClient } from '../src/client/live.js';
import { diffOps } from '../src/text.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function signIn(origin, name, email) {
  const r = await fetch(`${origin}/api/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email }) });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

export class Human {
  /** Opens the room like the editor does: state over HTTP first, then the websocket. */
  static async join(origin, slug, file, { name = 'Ada Human', email = 'ada@humans.test', connect = true } = {}) {
    const h = new Human();
    Object.assign(h, { origin, slug, file, name, email, controls: [], status: {}, refused: null });
    h.token = await signIn(origin, name, email);
    const r = await fetch(`${origin}/api/r/${slug}/state?path=${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${h.token}` } });
    if (!r.ok) { const e = new Error(`open failed: ${r.status} ${await r.text()}`); e.status = r.status; throw e; }
    h.room = JSON.parse(Buffer.from(r.headers.get('x-room'), 'base64url').toString('utf8'));
    h.doc = new Y.Doc();
    Y.applyUpdate(h.doc, new Uint8Array(await r.arrayBuffer()), 'http');
    h.ytext = h.doc.getText('text');
    h.awareness = new Awareness(h.doc);
    h.awareness.setLocalStateField('user', { name, email, color: '#30bced' });
    h.client = new LiveClient({
      url: () => `${origin.replace(/^http/, 'ws')}/ws?repo=${encodeURIComponent(slug)}&path=${encodeURIComponent(file)}&docId=${h.room.docId}&token=${encodeURIComponent(h.token)}`,
      doc: h.doc,
      awareness: h.awareness,
      onControl: (msg) => { h.controls.push({ ...msg, seenAt: Date.now() }); if (msg.type === 'hello' || msg.type === 'state') h.room = { ...h.room, ...msg }; },
      onStatus: (s) => { h.status = s; },
      onRefused: (code, reason) => { h.refused = reason; return false; },
    });
    if (connect) { h.client.connect(); await h.synced(); }
    return h;
  }

  text() { return this.ytext.toString(); }

  async synced(ms = 15000) {
    const t0 = Date.now();
    while (!this.client.synced) {
      if (this.refused) throw new Error(`connection refused: ${this.refused}`);
      if (Date.now() - t0 > ms) throw new Error('not synced with the service');
      await sleep(5);
    }
  }

  /** Changes the text with fn(text) as targeted inserts and deletes; resolves when the service confirmed it. */
  async edit(fn, { wait = true } = {}) {
    const before = this.text();
    const after = fn(before);
    const ops = diffOps(before, after);
    this.doc.transact(() => {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (ops[i].remove) this.ytext.delete(ops[i].index, ops[i].remove);
        if (ops[i].insert) this.ytext.insert(ops[i].index, ops[i].insert);
      }
    }, 'typing');
    if (wait) await this.settle();
  }

  /** Inserts at a position, like a keystroke. */
  type(index, text) { this.ytext.insert(index, text); }

  async settle(ms = 15000) {
    const t0 = Date.now();
    while (this.client.pending()) {
      if (Date.now() - t0 > ms) throw new Error('the service did not confirm the edit');
      await sleep(5);
    }
  }

  of(type) { return this.controls.filter((c) => c.type === type); }

  close() { this.client.close(); this.awareness.destroy(); }
}
