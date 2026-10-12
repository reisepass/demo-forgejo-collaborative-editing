// Line-based three-way merge for the two-way sync: `base` is the last text both sides agreed on,
// `local` is the file, `remote` is the pad.
//
// Rules:
//  - a change made on one side only is taken;
//  - changes on both sides that touch different lines are both taken, also when the lines are
//    next to each other;
//  - the same change on both sides is taken once;
//  - two insertions at the same place are both kept, the remote one first;
//  - anything else that overlaps is a conflict: the REMOTE lines win in the merged text and the
//    conflict is reported, so the caller can keep the local version somewhere safe.
//
// With the option `words` an overlap gets a second chance before it counts as a conflict: the
// lines of that region are merged once more word by word (see mergeWords below).

const MAX_D = 4000;

/** Splits into lines, each keeping its line break. */
export function splitLines(text) {
  if (text === '') return [];
  const out = text.split(/(?<=\n)/);
  return out;
}

// Myers O(ND) over two arrays of integers. Returns the changed runs as {s, e, bs, be}: lines
// [s, e) of `a` are replaced by lines [bs, be) of `b`. Gives up past MAX_D differences and
// reports everything as one run (still correct, just coarse).
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ s: 0, e: n, bs: 0, be: m }];
  const max = Math.min(n + m, MAX_D);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  if (found === -1) return [{ s: 0, e: n, bs: 0, be: m }];
  // walk back; trace[d] is the state before round d, stored for k in [-d-1, d+1]
  const steps = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d];
    const at = (k) => t[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    // the single edit of this round, then the diagonal
    steps.push(down ? { x: px, y: py, ins: 1, del: 0 } : { x: px, y: py, ins: 0, del: 1 });
    x = px;
    y = py;
  }
  steps.reverse();
  const runs = [];
  for (const st of steps) {
    const last = runs[runs.length - 1];
    if (last && last.e === st.x && last.be === st.y) { last.e += st.del; last.be += st.ins; }
    else runs.push({ s: st.x, e: st.x + st.del, bs: st.y, be: st.y + st.ins });
  }
  return runs;
}

/**
 * Changed runs that turn `a` into `b` (arrays of lines).
 * @returns {Array<{s: number, e: number, lines: string[]}>} lines [s, e) of `a` become `lines`
 */
export function diffLines(a, b) {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let q = 0;
  while (q < max - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const ids = new Map();
  const id = (line) => {
    let n = ids.get(line);
    if (n === undefined) { n = ids.size; ids.set(line, n); }
    return n;
  };
  const ma = a.slice(p, a.length - q).map(id);
  const mb = b.slice(p, b.length - q).map(id);
  return myers(ma, mb).map((r) => ({ s: r.s + p, e: r.e + p, lines: b.slice(r.bs + p, r.be + p) }));
}

const touches = (h, s, e) => (h.s < e && s < h.e) || (h.s === h.e && s === e && h.s === s);

const sameLines = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);

// base lines [s, e) with the hunks (all inside that range) applied
function applyWithin(base, hunks, s, e) {
  const out = [];
  let pos = s;
  for (const h of hunks) {
    for (let i = pos; i < h.s; i++) out.push(base[i]);
    out.push(...h.lines);
    pos = h.e;
  }
  for (let i = pos; i < e; i++) out.push(base[i]);
  return out;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Splits into words, runs of blanks, line breaks and single punctuation characters (Unicode word
 * boundaries; an emoji sequence is one token). Joining the tokens gives the text back.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const out = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

const wordCache = new Map();
// a token that carries meaning on its own: a word, a number, an emoji (not blanks or punctuation)
function isWord(token) {
  let known = wordCache.get(token);
  if (known === undefined) {
    known = PICTURE.test(token);
    if (!known) for (const part of segmenter.segment(token)) { known = !!part.isWordLike; break; }
    if (wordCache.size > 20000) wordCache.clear();
    wordCache.set(token, known);
  }
  return known;
}

// A pure insertion or a pure removal next to equal tokens can be written down at several places
// ("a b" -> "a x b" inserts "x " before "b" or " x" after "a"). Each run is moved as far left as
// it goes, and `we` is set to where it would end when moved as far right as it goes, so that two
// runs are compared by all the tokens either reading could touch. `min` is where the run before
// it ends.
function settle(o, h, min) {
  let { s, e } = h;
  let lines = h.lines;
  const n = lines.length;
  let right = 0;
  if (s === e && n) {
    while (e + right < o.length && o[e + right] === lines[right % n]) right++;
    let left = 0;
    while (s - left > min && o[s - left - 1] === lines[(((n - 1 - left) % n) + n) % n]) left++;
    if (left) {
      const k = left % n;
      lines = [...lines.slice(n - k), ...lines.slice(0, n - k)];
      s -= left;
      e -= left;
      right += left;
    }
  } else if (!n && e > s) {
    while (e + right < o.length && o[e + right] === o[s + right]) right++;
    let left = 0;
    while (s - left > min && o[s - left - 1] === o[e - left - 1]) left++;
    s -= left;
    e -= left;
    right += left;
  }
  return { s, e, we: e + right, lines };
}

// Changed runs of one side, with runs that are separated by less than two words taken together
// as one range: someone who rewrote "we should | ship it today" around a word did not leave that
// word alone on purpose.
function wordRuns(o, hunks) {
  const out = [];
  for (const h of hunks) {
    const last = out[out.length - 1];
    let words = 0;
    if (last) for (let k = last.e; k < h.s && words < 2; k++) if (isWord(o[k])) words++;
    if (last && (words < 2 || h.s < last.e)) {
      if (h.s < last.e) return null; // two runs that moved onto each other: leave it to the caller
      last.lines.push(...o.slice(last.e, h.s), ...h.lines);
      last.e = h.e;
      last.we = Math.max(last.we, h.we);
    } else out.push({ s: h.s, e: h.e, we: h.we, lines: h.lines.slice() });
  }
  return out;
}

const isBreak = (token) => token.includes('\n');
const sameRun = (a, b) => a.s === b.s && a.e === b.e && sameLines(a.lines, b.lines);

/**
 * Three-way merge of a short piece of text word by word, all or nothing.
 *
 * Changes that both sides made in exactly the same way are taken once. The rest is taken when
 * every changed range of one side is separated from every changed range of the other side by at
 * least one token that neither side touched (a blank counts). Ranges that share a token, touch
 * each other or insert at the same place are not merged; an insertion or removal that could sit
 * on either side of a blank counts as touching both of its neighbours. Changed runs of one side with less
 * than two words between them count as one range. If both sides changed where the lines break
 * (wrapped or joined lines), nothing is merged.
 * @param {string} base
 * @param {string} local
 * @param {string} remote
 * @returns {string|null} the merged text, or null when the two sides cannot be told apart safely
 */
export function mergeWords(base, local, remote) {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;
  if (base === '' || local === '' || remote === '') return null;
  const o = tokenize(base);
  const settled = (hunks) => hunks.map((h, k) => settle(o, h, k ? hunks[k - 1].e : 0));
  const rawA = settled(diffLines(o, tokenize(local)));
  const rawB = settled(diffLines(o, tokenize(remote)));
  const shared = rawA.filter((a) => rawB.some((b) => sameRun(a, b)));
  const own = (raw) => wordRuns(o, raw.filter((h) => !shared.some((x) => sameRun(h, x))));
  const A = own(rawA);
  const B = own(rawB);
  if (A === null || B === null) return null;
  const breaks = (runs) => runs.some((h) => h.lines.some(isBreak) || o.slice(h.s, h.e).some(isBreak));
  if (breaks(A) && breaks(B)) return null;
  const take = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    const a = A[i];
    const b = B[j];
    if (!b) { take.push(a); i++; continue; }
    if (!a) { take.push(b); j++; continue; }
    if (a.we < b.s) { take.push(a); i++; continue; }
    if (b.we < a.s) { take.push(b); j++; continue; }
    return null;
  }
  take.push(...shared);
  take.sort((x, y) => x.s - y.s || x.e - y.e);
  return applyWithin(o, take, 0, o.length).join('');
}

const WORD_DIFF_LIMIT = 1000;

/**
 * Size of the edit that turns `a` into `b`, at two grains: `lines` is the number of lines removed
 * plus the number inserted; `words` is the number of tokens (see tokenize) removed plus the
 * number inserted, counted inside the lines that differ. Both are 0 only for equal texts.
 * @param {string} a
 * @param {string} b
 * @returns {{lines: number, words: number}}
 */
export function editCost(a, b) {
  if (a === b) return { lines: 0, words: 0 };
  const la = splitLines(a);
  let lines = 0;
  let words = 0;
  for (const h of diffLines(la, splitLines(b))) {
    lines += (h.e - h.s) + h.lines.length;
    const from = tokenize(la.slice(h.s, h.e).join(''));
    const to = tokenize(h.lines.join(''));
    if (!from.length || !to.length || from.length > WORD_DIFF_LIMIT || to.length > WORD_DIFF_LIMIT) { words += from.length + to.length; continue; }
    for (const r of diffLines(from, to)) words += (r.e - r.s) + r.lines.length;
  }
  return { lines, words };
}

/**
 * How much two lines have in common, counted in words (numbers and emoji count, blanks and
 * punctuation do not): `common` words appear in both in the same order.
 * @param {string} a
 * @param {string} b
 * @returns {{common: number, a: number, b: number}} `a` and `b` are the word counts of the two lines
 */
export function wordOverlap(a, b) {
  const wa = tokenize(a).filter(isWord);
  const wb = tokenize(b).filter(isWord);
  let removed = 0;
  for (const r of diffLines(wa, wb)) removed += r.e - r.s;
  return { common: wa.length - removed, a: wa.length, b: wb.length };
}

/** The `words` of editCost. */
export function editSize(a, b) {
  return editCost(a, b).words;
}

/**
 * @param {string} base
 * @param {string} local
 * @param {string} remote
 * @param {object} [options]
 * @param {boolean} [options.words] default false. When true, lines that both sides changed are
 *   merged word by word where that is safe (mergeWords) instead of being reported as a conflict,
 *   and the result carries `wordMerges`, the number of regions merged that way.
 * @returns {{text: string, conflicts: Array<{line: number, base: string, local: string, remote: string}>, wordMerges?: number}}
 *   `text` is the merge with the remote side winning every conflict; `line` is the 1-based line in base
 */
export function merge3(base, local, remote, options = {}) {
  const words = !!options.words;
  const done = (text, conflicts, wordMerges) => (words ? { text, conflicts, wordMerges } : { text, conflicts });
  if (local === base || local === remote) return done(remote, [], 0);
  if (remote === base) return done(local, [], 0);
  const o = splitLines(base);
  const A = diffLines(o, splitLines(local));
  const B = diffLines(o, splitLines(remote));
  const out = [];
  const conflicts = [];
  let wordMerges = 0;
  let pos = 0;
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    const a = A[i];
    const b = B[j];
    // the hunk that starts first opens a region; on a tie the one that ends first
    const first = !b || (a && (a.s < b.s || (a.s === b.s && a.e <= b.e))) ? 'a' : 'b';
    const h = first === 'a' ? a : b;
    let s = h.s;
    let e = h.e;
    const as = [];
    const bs = [];
    if (first === 'a') { as.push(a); i++; } else { bs.push(b); j++; }
    for (let grown = true; grown;) {
      grown = false;
      while (i < A.length && touches(A[i], s, e)) { as.push(A[i]); s = Math.min(s, A[i].s); e = Math.max(e, A[i].e); i++; grown = true; }
      while (j < B.length && touches(B[j], s, e)) { bs.push(B[j]); s = Math.min(s, B[j].s); e = Math.max(e, B[j].e); j++; grown = true; }
    }
    for (let k = pos; k < s; k++) out.push(o[k]);
    pos = e;
    if (!bs.length) { out.push(...applyWithin(o, as, s, e)); continue; }
    if (!as.length) { out.push(...applyWithin(o, bs, s, e)); continue; }
    const mine = applyWithin(o, as, s, e);
    const theirs = applyWithin(o, bs, s, e);
    if (sameLines(mine, theirs)) { out.push(...theirs); continue; }
    if (s === e) { out.push(...theirs, ...mine); continue; } // two insertions at the same place
    if (words) {
      const both = mergeWords(o.slice(s, e).join(''), mine.join(''), theirs.join(''));
      if (both !== null) { out.push(both); wordMerges++; continue; }
    }
    out.push(...theirs);
    conflicts.push({ line: s + 1, base: o.slice(s, e).join(''), local: mine.join(''), remote: theirs.join('') });
  }
  for (let k = pos; k < o.length; k++) out.push(o[k]);
  return done(out.join(''), conflicts, wordMerges);
}
