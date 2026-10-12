// Who may do what is Forgejo's decision: push permission edits, read permission watches, nobody
// is let in without signing in to Forgejo.
import { test, expect } from '@playwright/test';
import {
  BASE, REPO, S, agentClone, editorText, fileOn, fileUrl, fillSignIn, forgejoApi, fullPageUrl, lastCommit, liveUrl, newFile, newPage, openLive, people, signedIn, sleep, typeAtEndOfLine,
} from './fixtures.js';
import { git } from '../scripts/lib.mjs';

let agent;
test.beforeAll(async () => { agent = await agentClone('perm'); });

test('carol (read only) watches live but cannot write, in the editor or around it', async ({ browser }) => {
  const file = await newFile(agent, 'readonly');
  const ada = await signedIn(browser, 'ada');
  const carol = await signedIn(browser, 'carol');
  await openLive(ada, file);
  await openLive(carol, file);

  // told so, and the editor takes no input
  await expect(carol.getByTestId('read-only')).toContainText('view only');
  await expect(carol.getByTestId('save-state')).toHaveAttribute('data-access', 'read');
  await expect(carol.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  const before = await editorText(carol);
  await carol.locator('.cm-content').click();
  await carol.keyboard.type('carol tries to type');
  expect(await editorText(carol)).toBe(before);

  // she sees what ada types as it is typed, and ada sees that carol is there
  await typeAtEndOfLine(ada, 'line 06', ' ada, watched by carol', 10);
  await expect.poll(() => editorText(carol)).toContain('line 06 original ada, watched by carol');
  await expect(ada.getByTestId('person')).toHaveText(['Ada Lovelace (you)', 'Carol Reader']);

  // past the editor: a change put into her document by script is sent, and dropped by the service
  await carol.evaluate(() => { const v = window.__lb.view; v.dispatch({ changes: { from: 0, insert: 'INJECTED BY CAROL\n' } }); });
  expect(await editorText(carol)).toContain('INJECTED BY CAROL');
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await sleep(2500);
  expect(await editorText(ada)).not.toContain('INJECTED');
  expect(await fileOn('main', file)).not.toContain('INJECTED');
  expect((await lastCommit(file)).commit.author.email).toBe(people.ada.email);
  // the service's writing endpoints refuse her
  const refused = await carol.evaluate(async ([repo, f]) => {
    const r = await fetch(`/live/api/r/${repo}/orphan?path=${encodeURIComponent(f)}`, { method: 'POST', body: 'carol was here\n' });
    return { status: r.status, body: await r.json() };
  }, [REPO, file]);
  expect(refused).toMatchObject({ status: 403, body: { code: 'NO_PUSH' } });
  // and Forgejo itself refuses her push, so nothing depends on the service alone
  const clone = await agentClone('carol');
  await clone.commit(file, (t) => `${t}pushed by carol\n`);
  const push = await git(clone.dir, ['push', `http://carol:${people.carol.token}@127.0.0.1:${S.ports.proxy}/${REPO}.git`, 'HEAD:main'], { allowFail: true });
  expect(push.code).not.toBe(0);
  expect(await fileOn('main', file)).not.toContain('pushed by carol');
  await ada.context().close();
  await carol.context().close();
});

test('an anonymous visitor is sent to Forgejo\'s sign-in and comes back to the editor', async ({ browser }) => {
  const file = await newFile(agent, 'anon');
  const page = await newPage(browser);
  // the repository is public: the file page and the button are there
  await page.goto(fileUrl(file));
  await expect(page.locator('.file-view')).toContainText('line 01 original');
  await page.getByTestId('edit-live').click();
  await expect(page).toHaveURL(/\/user\/login/);
  await expect(page.locator('input[name="user_name"]')).toBeVisible();
  // signing in as bob continues where the click wanted to go
  await fillSignIn(page, 'bob');
  const authorize = page.locator('#authorize-app');
  await expect(authorize.or(page.getByTestId('save-state')).first()).toBeVisible();
  if (await authorize.isVisible()) await authorize.click();
  await expect(page).toHaveURL(liveUrl(file));
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await expect(page.getByTestId('person')).toHaveText(['Bob Builder (you)']);
  await page.context().close();

  // the full-page editor and the service's API and websocket: nothing without a session
  const anon = await newPage(browser);
  await anon.goto(fullPageUrl(file));
  await expect(anon).toHaveURL(/\/user\/login/);
  const api = await fetch(`${BASE}/live/api/r/${REPO}/state?path=${encodeURIComponent(file)}`);
  expect(api.status).toBe(401);
  const tree = await fetch(`${BASE}/live/api/r/${REPO}/tree`);
  expect(tree.status).toBe(401);
  const ws = await new Promise((resolve) => {
    const s = new WebSocket(`${BASE.replace('http', 'ws')}/live/ws?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent(file)}`);
    s.onopen = () => { s.close(); resolve('open'); };
    s.onerror = () => resolve('refused');
  });
  expect(ws).toBe('refused');
  // the operator endpoints of the service are not on the public address at all
  expect((await fetch(`${BASE}/live/api/status`)).status).toBe(404);
  expect((await fetch(`${BASE}/live/internal/poke/x`, { method: 'POST' })).status).toBe(404);
  await anon.context().close();
});

test('a session cookie alone, sent from another site, opens no websocket', async ({ browser }) => {
  const file = await newFile(agent, 'origin');
  const page = await signedIn(browser, 'ada');
  await openLive(page, file);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'lb_session');
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  const attempt = (origin) => new Promise((resolve) => {
    const s = new WebSocket(`${BASE.replace('http', 'ws')}/live/ws?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent(file)}`, { headers: { cookie: `lb_session=${cookie.value}`, origin } });
    s.onopen = () => { s.close(); resolve('open'); };
    s.onerror = () => resolve('refused');
  });
  expect(await attempt('http://evil.example')).toBe('refused');
  expect(await attempt(BASE)).toBe('open');
  await page.context().close();
});

test('branch protection in Forgejo applies to live editing: commits are pushed as the person who typed', async ({ browser }) => {
  const adaFile = await newFile(agent, 'protected-ada');
  const bobFile = await newFile(agent, 'protected-bob');
  const ada = await signedIn(browser, 'ada');
  const bob = await signedIn(browser, 'bob');
  await openLive(ada, adaFile);
  await openLive(bob, bobFile);
  // main: only bob may push
  await forgejoApi('POST', `/repos/${REPO}/branch_protections`, { body: { branch_name: 'main', enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ['bob'] } });
  try {
    await typeAtEndOfLine(bob, 'line 02', ' bob may push', 5);
    await expect(bob.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
    expect(await fileOn('main', bobFile)).toContain('line 02 original bob may push\n');

    await typeAtEndOfLine(ada, 'line 02', ' ada may not push right now', 5);
    // Forgejo refuses her commit; she is told why and the text stays in the editor
    await expect(ada.getByTestId('flush-failed')).toContainText('protected branch', { timeout: 30000 });
    await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
    expect(await fileOn('main', adaFile)).not.toContain('ada may not push');
    expect(await editorText(ada)).toContain('line 02 original ada may not push right now');
  } finally {
    await forgejoApi('DELETE', `/repos/${REPO}/branch_protections/main`);
  }
  // protection lifted: the service was still trying, her text lands under her name
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved', { timeout: 60000 });
  await expect(ada.getByTestId('flush-failed')).toHaveCount(0);
  expect(await fileOn('main', adaFile)).toContain('line 02 original ada may not push right now\n');
  expect((await lastCommit(adaFile)).commit.author.email).toBe(people.ada.email);
  await ada.context().close();
  await bob.context().close();
});
