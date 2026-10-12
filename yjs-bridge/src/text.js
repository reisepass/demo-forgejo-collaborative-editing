// Text plumbing between git blobs, the Y.Text and the editors.
//
// The Y.Text always holds LF line breaks: CodeMirror counts every line break as one character, so
// a CRLF inside the shared text would shift every position behind it. What git holds is kept
// byte-exact all the same: a commit is built by laying the edited lines over the raw base text,
// so every untouched line keeps its own line ending and edited lines take the ending of the line
// they replace (or the file's most common one).
import { diffLines, splitLines, tokenize } from './shared/merge.js';

export const toLF = (text) => text.replace(/\r\n?/g, '\n');

/** Lines of a raw text, each keeping its own line break (\r\n, \n or a lone \r). */
export function splitRaw(text) {
  return text === '' ? [] : text.split(/(?<=\r\n|\r(?!\n)|\n)/);
}

const eolOf = (line) => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : line.endsWith('\r') ? '\r' : '');

/**
 * The file content for `live` (LF text of the editors), given the raw text `baseRaw` it grew from.
 * fromLF(toLF(x), x) === x for every x.
 */
export function fromLF(live, baseRaw) {
  if (!baseRaw.includes('\r')) return live;
  const raw = splitRaw(baseRaw);
  const base = raw.map(toLF);
  const counts = new Map();
  for (const l of raw) { const e = eolOf(l); if (e) counts.set(e, (counts.get(e) || 0) + 1); }
  let dominant = '\n';
  let best = 0;
  for (const [e, n] of counts) if (n > best) { best = n; dominant = e; }
  const lines = splitLines(live);
  const out = [];
  let pos = 0;
  for (const h of diffLines(base, lines)) {
    for (let i = pos; i < h.s; i++) out.push(raw[i]);
    h.lines.forEach((l, k) => {
      if (!l.endsWith('\n')) { out.push(l); return; }
      const old = h.s + k < h.e ? eolOf(raw[h.s + k]) : '';
      out.push(l.slice(0, -1) + (old || dominant));
    });
    pos = h.e;
  }
  for (let i = pos; i < raw.length; i++) out.push(raw[i]);
  return out.join('');
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
const TOKEN_LIMIT = 4000;

function trimmed(a, b, base, out) {
  if (a === b) return;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  out.push({ index: base + p, remove: a.length - p - s, insert: b.slice(p, b.length - s) });
}

/**
 * The smallest set of edits this module knows that turns `a` into `b`: changed runs of lines,
 * refined word by word, each refined once more by cutting the common head and tail.
 * @returns {Array<{index: number, remove: number, insert: string}>} ascending, indexes into `a`
 */
export function diffOps(a, b) {
  if (a === b) return [];
  const la = splitLines(a);
  const lb = splitLines(b);
  const starts = new Array(la.length + 1);
  starts[0] = 0;
  for (let i = 0; i < la.length; i++) starts[i + 1] = starts[i] + la[i].length;
  const out = [];
  for (const h of diffLines(la, lb)) {
    const from = la.slice(h.s, h.e).join('');
    const to = h.lines.join('');
    const at = starts[h.s];
    if (!from || !to) { out.push({ index: at, remove: from.length, insert: to }); continue; }
    const ta = tokenize(from);
    const tb = tokenize(to);
    if (ta.length > TOKEN_LIMIT || tb.length > TOKEN_LIMIT) { trimmed(from, to, at, out); continue; }
    const ts = new Array(ta.length + 1);
    ts[0] = 0;
    for (let i = 0; i < ta.length; i++) ts[i + 1] = ts[i] + ta[i].length;
    for (const r of diffLines(ta, tb)) trimmed(ta.slice(r.s, r.e).join(''), r.lines.join(''), at + ts[r.s], out);
  }
  return out;
}

export function applyOps(a, ops) {
  let out = a;
  for (const o of [...ops].sort((x, y) => y.index - x.index)) out = out.slice(0, o.index) + o.insert + out.slice(o.index + o.remove);
  return out;
}

/** Applies diffOps(live, target) to a Y.Text. Call inside a transaction. Returns the number of edits. */
export function applyToYText(ytext, live, target) {
  const ops = diffOps(live, target);
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.remove) ytext.delete(o.index, o.remove);
    if (o.insert) ytext.insert(o.index, o.insert);
  }
  return ops.length;
}
