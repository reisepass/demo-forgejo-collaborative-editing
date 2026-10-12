// Tier 6 in a real browser: the service is killed with SIGKILL again and again while a person
// types; the page is never reloaded and reconnects by itself.
import { test, expect } from '@playwright/test';
import { DOC, until } from '../test/helpers.js';
import { editorText, openEditor, person, setup, sleep, typeAtEndOfLine } from './fixtures.js';

const KILLS = Number(process.env.CRASH_KILLS || 20);
const worlds = [];
test.afterAll(async () => { for (const w of worlds) await w.stop(); });
const between = (a, b) => a + Math.floor(Math.random() * (b - a));
const count = (text, needle) => text.split(needle).length - 1;

test(`kill -9 at ${KILLS} random moments while a person types in the browser: every marker ends on main once, the page reconnects by itself`, async ({ browser }) => {
  test.setTimeout(300000);
  const { w, b: first } = await setup('e-crash', { debounceMs: 500, maxWaitMs: 1500 });
  worlds.push(w);
  let b = first;
  const port = b.port;
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  await openEditor(ada, b);
  const typed = [];
  let typing = true;
  const typer = (async () => {
    for (let k = 1; typing; k++) {
      const m = `m${String(k).padStart(4, '0')}`;
      await typeAtEndOfLine(ada, `line ${String(3 + (k % 4)).padStart(2, '0')} `, ` ${m}`, 25);
      typed.push(m);
      await sleep(between(50, 300));
    }
  })();
  let dirtyAtKill = 0;
  let sawOffline = 0;
  for (let i = 1; i <= KILLS; i++) {
    await sleep(between(400, 3000));
    const s = await b.session().catch(() => null);
    if (s?.dirty) dirtyAtKill += 1;
    await b.kill('SIGKILL');
    if (i % 4 === 0) { await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'offline'); sawOffline += 1; }
    await sleep(between(0, 1200));
    b = await w.startBridge({ debounceMs: 500, maxWaitMs: 1500, port });
  }
  await sleep(1000);
  typing = false;
  await typer;
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved', { timeout: 30000 });
  const text = await editorText(ada);
  await until(async () => (await w.main('docs/x.md')) === text, 'main to equal the editor', 20000);
  const main = await w.main('docs/x.md');
  const missing = typed.filter((m) => count(main, m) === 0);
  const dup = typed.filter((m) => count(main, m) > 1);
  const connects = await ada.evaluate(() => window.__lb.client.connects);
  console.log(`# ${KILLS} kills; ${typed.length} markers typed in the browser; unflushed text at the kill: ${dirtyAtKill} of ${KILLS}; missing on main: ${missing.length}; duplicated: ${dup.length}; the page reconnected ${connects - 1} times; "not connected" seen in the status line ${sawOffline} of ${sawOffline} times it was looked for`);
  expect(missing).toEqual([]);
  expect(dup).toEqual([]);
  expect(connects - 1).toBeGreaterThanOrEqual(KILLS);
  expect(await ada.evaluate(() => window.__neverReloaded)).toBe(true);
  expect(main.split('\n').length).toBe(DOC.split('\n').length);
  expect(await w.branches()).toEqual([]);
  await w.assertMainOnlyMovedForward();
  expect(ada.problems).toEqual([]);
});
