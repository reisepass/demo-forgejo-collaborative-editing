// An agent pushes with plain git; the text shows up in the open editor without a reload.
// Measured: from the moment `git push` returned to the moment the text is in the editor.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { S, agentClone, editorText, fileOn, newFile, openLive, pct, serviceStatus, signedIn, sleep } from './fixtures.js';
import { file as homeFile } from '../scripts/lib.mjs';

const PUSHES = Number(process.env.E2E_PUSHES || 25);

test(`${PUSHES} agent pushes appear in the open editor without a reload`, async ({ browser }) => {
  const agent = await agentClone('pusher');
  const file = await newFile(agent, 'agent');
  const page = await signedIn(browser, 'ada');
  await openLive(page, file);
  const before = (await serviceStatus()).counters;

  const times = [];
  const stamps = [];
  for (let i = 1; i <= PUSHES; i++) {
    const needle = `agent push ${String(i).padStart(2, '0')}`;
    await agent.pull();
    await agent.commit(file, (t) => `${t}${needle}\n`, `agent: push ${i}`);
    const started = new Date().toISOString();
    const r = await agent.pushOnce();
    expect(r.code, r.stderr).toBe(0);
    const t0 = performance.now();
    stamps.push({ needle, pushStarted: started, pushReturned: new Date().toISOString(), pushMs: Math.round(r.ms) });
    await page.waitForFunction((n) => window.__lb.text().includes(n), needle, { polling: 'raf', timeout: 30000 });
    times.push(performance.now() - t0);
    // the editor says who changed it
    await expect(page.getByTestId('fold-author').first()).toHaveText('Coding Agent');
    await sleep(150 + Math.random() * 500);
  }
  expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);
  expect(await editorText(page)).toBe(await fileOn('main', file));

  const result = { pushes: PUSHES, medianMs: Math.round(pct(times, 0.5)), p95Ms: Math.round(pct(times, 0.95)), maxMs: Math.round(Math.max(...times)), minMs: Math.round(Math.min(...times)), timesMs: times.map(Math.round), stamps,
    paths: { webhook: !process.env.LIVE_NO_WEBHOOK, pokeHook: !process.env.LIVE_NO_POKE_HOOK && !process.env.LIVE_NO_REPO_DIR, readsFromDisk: !process.env.LIVE_NO_REPO_DIR, forgejoQueues: process.env.LIVE_FORGEJO_QUEUES || 'channel', pollMs: Number(process.env.LIVE_POLL_MS) } };
  writeFileSync(homeFile('latency.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`push returned -> visible in the editor: median ${result.medianMs} ms, p95 ${result.p95Ms} ms, min ${result.minMs} ms, max ${result.maxMs} ms over ${PUSHES} pushes (${JSON.stringify(result.paths)}); stack ${S.home}`);
  const after = (await serviceStatus()).counters;
  expect(after.folds - before.folds).toBeGreaterThanOrEqual(PUSHES);
  // well inside the polling interval: the pushes were announced, not found by polling
  if (result.paths.webhook || result.paths.pokeHook) expect(result.p95Ms).toBeLessThan(Number(process.env.LIVE_POLL_MS) / 2);
  expect(page.problems).toEqual([]);
  await page.context().close();
});
