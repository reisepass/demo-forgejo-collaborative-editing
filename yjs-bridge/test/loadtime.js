#!/usr/bin/env node
// Tier 4: how long the editor route takes, from the start of the navigation to
//   text      the document text is drawn (first animation frame after the editor exists)
//   typed     a character typed as soon as the editor is there has arrived in the editor
// cold = a new browser profile for every load (nothing cached), warm = the same profile again.
// Small = 2 kB, large = 500 kB. Median of LOAD_RUNS (15) loads each. The room is already open on
// the service (someone else is in the file); what a first open costs on the service is measured
// on its own at the end.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeWorld, sleep } from './helpers.js';
import { signIn } from './human.js';

const RUNS = Number(process.env.LOAD_RUNS || 15);
const para = (i) => `## Section ${i}\n\nThe quick brown fox jumps over the lazy dog, again and again, in paragraph number ${i} of this file.\n\n- item one of ${i}\n- item two of ${i}\n\n`;
const sized = (bytes) => { let s = '# Load test document\n\n'; for (let i = 1; s.length < bytes; i++) s += para(i); return s.slice(0, bytes - 1) + '\n'; };
const files = { 'docs/small.md': sized(2000), 'docs/large.md': sized(500000) };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const stat = (xs) => ({ median: Math.round(median(xs)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) });

const w = await makeWorld('load', { files });
const b = await w.startBridge({ debounceMs: 60000, emptyMs: 600000 });
const keep = [await b.human('docs/small.md', 'Keeper', 'keeper@humans.test'), await b.human('docs/large.md', 'Keeper', 'keeper@humans.test')];
const token = await signIn(b.origin, 'Ada Human', 'ada@humans.test');
const browser = await chromium.launch({ headless: true });

async function load(page, file) {
  const first = files[file].split('\n')[0];
  await page.goto(`${b.origin}/r/${w.slug}/edit/${file}`, { waitUntil: 'commit' });
  await page.locator('.cm-content').waitFor();
  await page.keyboard.type('x');
  await page.waitForFunction(() => window.__lb && window.__lb.marks.firstInput && window.__lb.marks.textPainted && window.__lb.marks.synced);
  const m = await page.evaluate(() => ({ ...window.__lb.marks, length: window.__lb.view.state.doc.length, firstLine: window.__lb.view.state.doc.line(1).text }));
  if (!m.firstLine.includes(first.slice(0, 10))) throw new Error(`unexpected first line: ${m.firstLine}`);
  // take the typed character out again, so every load starts from the same document
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !window.__lb.client.pending());
  return m;
}

const out = {};
for (const file of Object.keys(files)) {
  const cold = [];
  const warm = [];
  for (let i = 0; i < RUNS; i++) {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await context.addInitScript(([t, u]) => { localStorage.setItem('lb.token', t); localStorage.setItem('lb.user', u); }, [token, JSON.stringify({ name: 'Ada Human', email: 'ada@humans.test' })]);
    const page = await context.newPage();
    cold.push(await load(page, file));
    await page.goto('about:blank');
    warm.push(await load(page, file));
    await context.close();
  }
  const pick = (runs, k) => stat(runs.map((r) => r[k]));
  const row = (runs) => ({ stateFetched: pick(runs, 'stateFetched'), text: pick(runs, 'textPainted'), typed: pick(runs, 'firstInput'), websocketOpen: pick(runs, 'wsOpen'), inStepWithService: pick(runs, 'synced'), textBeforeWebsocket: runs.filter((r) => r.textPainted < r.wsOpen && r.wsOpenAtPaint === false).length });
  out[file] = { bytes: files[file].length, runs: RUNS, cold: row(cold), warm: row(warm) };
  console.log(`${file} (${files[file].length} bytes), median of ${RUNS}, ms from navigation start`);
  for (const [k, r] of [['cold', out[file].cold], ['warm', out[file].warm]]) console.log(`  ${k}: text ${r.text.median} (min ${r.text.min}, max ${r.text.max}); typed ${r.typed.median} (min ${r.typed.min}, max ${r.typed.max}); document fetched ${r.stateFetched.median}; websocket open ${r.websocketOpen.median}; in step ${r.inStepWithService.median}; text drawn before the websocket was open in ${r.textBeforeWebsocket} of ${RUNS}`);
}

// what the service needs to hand out a document: room already in memory, and a first open
for (const h of keep) h.close();
const fetchState = async (file, origin = b.origin) => { const t = performance.now(); const r = await fetch(`${origin}/api/r/${w.slug}/state?path=${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${token}` } }); await r.arrayBuffer(); return performance.now() - t; };
out.service = {};
for (const file of Object.keys(files)) {
  const live = [];
  for (let i = 0; i < RUNS; i++) live.push(await fetchState(file));
  out.service[file] = { roomInMemoryMs: stat(live) };
}
await b.stop();
const b2 = await w.startBridge({ debounceMs: 60000 });
for (const file of Object.keys(files)) out.service[file].firstOpenAfterServiceStartMs = Math.round(await fetchState(file, b2.origin));
console.log(`service: ${JSON.stringify(out.service)}`);
writeFileSync(path.join(w.dir, 'loadtime.json'), JSON.stringify(out, null, 1));
console.log(`result: ${path.join(w.dir, 'loadtime.json')}`);
await browser.close();
await sleep(100);
await w.stop();
process.exit(0);
