// Durable state of one room, outside any repository: an append-only file of records. A record
// carries the room's meta data (JSON) and/or a Yjs update, written with one write call, so a fold
// (merged text plus the new base commit) is on disk as a whole or not at all. A torn record at the
// end of the file is ignored when the log is read.
//
// A record is in the kernel's hands when append() returns, which is what survives a killed
// process. fsync runs a moment later (power loss is a different guarantee than `kill -9`).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

const EMPTY = new Uint8Array(0);

function frame(meta, update) {
  const json = meta ? Buffer.from(JSON.stringify(meta), 'utf8') : EMPTY;
  const up = update || EMPTY;
  const buf = Buffer.allocUnsafe(8 + json.length + up.length);
  buf.writeUInt32BE(4 + json.length + up.length, 0);
  buf.writeUInt32BE(json.length, 4);
  buf.set(json, 8);
  buf.set(up, 8 + json.length);
  return buf;
}

export class RoomLog {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.records = 0;
    this.bytes = 0;
    this.syncTimer = null;
  }

  exists() { return existsSync(this.file); }

  /** @returns {{meta: object|null, updates: Uint8Array[]}} the last meta data and every update, in order */
  read() {
    const buf = readFileSync(this.file);
    let meta = null;
    const updates = [];
    let pos = 0;
    let n = 0;
    while (pos + 8 <= buf.length) {
      const total = buf.readUInt32BE(pos);
      if (total < 4 || pos + 4 + total > buf.length) break;
      const jsonLen = buf.readUInt32BE(pos + 4);
      if (jsonLen > total - 4) break;
      if (jsonLen) {
        try { meta = JSON.parse(buf.subarray(pos + 8, pos + 8 + jsonLen).toString('utf8')); } catch { break; }
      }
      if (total - 4 - jsonLen) updates.push(new Uint8Array(buf.subarray(pos + 8 + jsonLen, pos + 4 + total)));
      pos += 4 + total;
      n += 1;
    }
    this.records = n;
    this.bytes = pos;
    this.torn = buf.length - pos;
    return { meta, updates };
  }

  #open() {
    if (this.fd === null) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.fd = openSync(this.file, 'a', 0o600);
    }
  }

  append(meta, update) {
    this.#open();
    const buf = frame(meta, update);
    writeSync(this.fd, buf);
    this.records += 1;
    this.bytes += buf.length;
    if (!this.syncTimer) {
      this.syncTimer = setTimeout(() => { this.syncTimer = null; if (this.fd !== null) { try { fsyncSync(this.fd); } catch { /* closed meanwhile */ } } }, 200);
      this.syncTimer.unref();
    }
  }

  /** Replaces the whole log by one record (temp file, fsync, rename). */
  compact(meta, update) {
    this.close();
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    const buf = frame(meta, update);
    try { writeSync(fd, buf); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    this.records = 1;
    this.bytes = buf.length;
  }

  close() {
    clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (this.fd !== null) { try { fsyncSync(this.fd); } catch { /* best effort */ } closeSync(this.fd); this.fd = null; }
  }

  remove() {
    this.close();
    try { unlinkSync(this.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
