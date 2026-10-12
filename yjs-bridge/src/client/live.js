// The editor's connection to its room. Runs in the browser and in Node (tests): it needs a Y.Doc,
// an Awareness and a WebSocket constructor.
//
// What is typed while the connection is down stays in the Y.Doc and travels with the first sync
// after it is back. `pending()` says whether the service has confirmed everything typed here.
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, awarenessMessage, control, decoding, encoding } from './protocol.js';

export class LiveClient {
  /**
   * @param {object} o
   * @param {() => string} o.url websocket URL (asked for at every connect)
   * @param {import('yjs').Doc} o.doc
   * @param {import('y-protocols/awareness').Awareness} o.awareness
   * @param {(msg: object) => void} [o.onControl] hello, state, notice, conflict, removed, reset
   * @param {(status: {connected: boolean, synced: boolean, pending: boolean}) => void} [o.onStatus]
   * @param {(code: number, reason: string) => boolean} [o.onRefused] return false to stop reconnecting
   */
  constructor({ url, doc, awareness, onControl, onStatus, onRefused, WebSocketImpl = globalThis.WebSocket }) {
    this.url = url;
    this.doc = doc;
    this.awareness = awareness;
    this.onControl = onControl || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onRefused = onRefused || (() => true);
    this.WS = WebSocketImpl;
    this.ws = null;
    this.connected = false;
    this.synced = false;
    this.sent = 0;
    this.acked = 0;
    this.offlineEdits = false;
    this.closed = false;
    this.retry = 0;
    this.connects = 0;
    this.onUpdate = (update, origin) => {
      if (origin === this) return;
      if (!this.connected) { this.offlineEdits = true; this.#status(); return; }
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.sent += 1;
      this.ws.send(encoding.toUint8Array(e));
      this.#status();
    };
    this.onAwareness = ({ added, updated, removed }, origin) => {
      if (origin !== 'local' || !this.connected) return;
      this.ws.send(awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed])));
    };
    doc.on('update', this.onUpdate);
    awareness.on('update', this.onAwareness);
  }

  /** True while something typed here has not been confirmed by the service. */
  pending() { return this.offlineEdits || this.sent > this.acked; }

  #status() { this.onStatus({ connected: this.connected, synced: this.synced, pending: this.pending() }); }

  connect() {
    if (this.closed) return;
    clearTimeout(this.timer);
    const ws = new this.WS(this.url());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.connects += 1;
      this.retry = 0;
      this.sent = 0;
      this.acked = 0;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, this.doc);
      ws.send(encoding.toUint8Array(e));
      if (this.awareness.getLocalState() !== null) ws.send(awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
      this.#status();
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.#message(new Uint8Array(ev.data)); };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      this.synced = false;
      if (this.sent > this.acked) this.offlineEdits = true;
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      if (others.length) awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      this.#status();
      if (this.closed) return;
      if (!was && ev.code === 1008 && this.onRefused(ev.code, ev.reason) === false) return;
      this.retry += 1;
      this.timer = setTimeout(() => this.connect(), Math.min(2000, 150 * 1.6 ** Math.min(this.retry, 8)));
    };
    ws.onerror = () => {};
  }

  #message(data) {
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(d, e, this.doc, this);
      if (encoding.length(e) > 1) {
        // the answer to the service's step 1 carries everything typed here that it does not have
        this.sent += 1;
        this.ws.send(encoding.toUint8Array(e));
      }
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) { this.synced = true; this.#status(); }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this);
    } else if (type === MSG_CONTROL) {
      const msg = JSON.parse(decoding.readVarString(d));
      if (msg.type === 'ack') {
        this.acked = msg.n;
        if (this.acked >= this.sent) this.offlineEdits = false;
        this.#status();
      } else this.onControl(msg);
    }
  }

  /** Sends a control message (for example {type: 'resume'}). */
  tell(obj) { if (this.connected) this.ws.send(control(obj)); }

  /** Drops the connection without stopping: it comes back by itself (for tests). */
  drop() { this.ws?.close(); }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.doc.off('update', this.onUpdate);
    this.awareness.off('update', this.onAwareness);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    this.ws?.close();
  }
}
