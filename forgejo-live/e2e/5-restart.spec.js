// An open editor outlives a restart of the editor service and a restart of Forgejo: nothing
// typed is lost, and the page is not reloaded.
import { test, expect } from '@playwright/test';
import { agentClone, editorText, fileOn, fileUrl, fullPageUrl, lastCommit, newFile, openLive, people, signedIn, stackScript, typeAtEndOfLine } from './fixtures.js';

let agent;
test.beforeAll(async () => { agent = await agentClone('restart'); });

test('the editor service is killed and started again while ada types', async ({ browser }) => {
  const file = await newFile(agent, 'service-restart');
  const page = await signedIn(browser, 'ada');
  await openLive(page, file);

  await typeAtEndOfLine(page, 'line 02', ' typed before the kill', 5);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
  // kill -9: no chance to flush
  stackScript('down', ['--only', 'service', '--kill']);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'offline');
  await typeAtEndOfLine(page, 'line 07', ' typed while the service was down', 5);
  expect(await fileOn('main', file)).not.toContain('typed before the kill');

  stackScript('up', ['--only', 'service', '--quiet']);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved', { timeout: 30000 });
  const main = await fileOn('main', file);
  expect(main).toContain('line 02 original typed before the kill\n');
  expect(main).toContain('line 07 original typed while the service was down\n');
  expect(await editorText(page)).toBe(main);
  expect((await lastCommit(file)).commit.author.email).toBe(people.ada.email);
  expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);
  await page.context().close();
});

test('Forgejo is stopped and started again while ada types', async ({ browser }) => {
  const file = await newFile(agent, 'forgejo-restart');
  const page = await signedIn(browser, 'ada');
  await openLive(page, file);

  stackScript('down', ['--only', 'forgejo']);
  await typeAtEndOfLine(page, 'line 03', ' typed while Forgejo was down', 5);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
  // the typing pause passes, the commit cannot be pushed: the text stays in the editor and the person is told
  await expect(page.getByTestId('flush-failed')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
  expect(await editorText(page)).toContain('line 03 original typed while Forgejo was down');
  // Forgejo's pages are away, the editor is not: its full-page URL opens in a new tab during the
  // outage and has the text (the service holds it)
  const tab = await page.context().newPage();
  expect((await tab.goto(fileUrl(file))).status()).toBe(502);
  await tab.goto(fullPageUrl(file));
  await expect(tab.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved', { timeout: 30000 });
  expect(await tab.evaluate(() => window.__lb.text())).toContain('line 03 original typed while Forgejo was down');
  await tab.close();

  stackScript('up', ['--only', 'forgejo', '--quiet']);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved', { timeout: 60000 });
  await expect(page.getByTestId('flush-failed')).toHaveCount(0);
  expect(await fileOn('main', file)).toContain('line 03 original typed while Forgejo was down\n');
  expect((await lastCommit(file)).commit.author.email).toBe(people.ada.email);
  expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);
  await page.context().close();
});
