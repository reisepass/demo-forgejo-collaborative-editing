// A person edits a markdown file from inside Forgejo's own pages, a second person joins, and the
// text lands in Forgejo's history under the name of who typed it.
import { test, expect } from '@playwright/test';
import {
  BASE, REPO, agentClone, branches, editorText, fileOn, fileUrl, forgejoApi, fullPageUrl, lastCommit, liveUrl, newFile, openLive, people, signedIn, typeAtEndOfLine,
} from './fixtures.js';

let agent;
test.beforeAll(async () => { agent = await agentClone('edit'); });

test('ada signs in through Forgejo, browses to a file, edits live, and the commit is hers in Forgejo', async ({ browser }) => {
  const file = await newFile(agent, 'ada');
  const [dir, name] = file.split('/');
  const page = await signedIn(browser, 'ada');

  // through Forgejo's own navigation: repository, folder, file
  await page.goto(`${BASE}/${REPO}`);
  await page.locator(`#repo-files-table a[href$="/src/branch/main/${dir}"]`).first().click();
  await page.locator(`a[href$="/${name}"]`).first().click();
  await expect(page).toHaveURL(fileUrl(file));
  await expect(page.locator('.file-view')).toContainText('line 03 original');

  // the injected button sits in Forgejo's file header, next to Raw / Permalink / Blame / History
  const button = page.locator('.file-header .file-actions').getByTestId('edit-live');
  await expect(button).toHaveText('Edit live');
  await button.click();
  // the first time, Forgejo asks whether the editor may act for ada (on a stack that has run
  // before she has answered already)
  const authorize = page.locator('#authorize-app');
  await expect(authorize.or(page.getByTestId('save-state')).first()).toBeVisible();
  if (process.env.E2E_FRESH) await expect(page).toHaveURL(/\/login\/oauth\/authorize/);
  if (await authorize.isVisible()) await authorize.click();

  // back on the file's page, now with the editor in place of the rendered file
  await expect(page).toHaveURL(liveUrl(file));
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await expect(page.locator('#navbar')).toBeVisible();
  await expect(page.locator('.repository .secondary-nav, .repo-header').first()).toBeVisible();
  await expect(page.locator('.file-view')).toBeHidden();
  await expect(page.getByTestId('person')).toHaveText(['Ada Lovelace (you)']);
  await page.evaluate(() => { window.__neverReloaded = true; });

  const before = await lastCommit(file);
  await typeAtEndOfLine(page, 'line 03', ' typed by ada', 15);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);

  // Forgejo's API: the newest commit of the file is ada's, the service is only the committer
  const c = await lastCommit(file);
  expect(c.sha).not.toBe(before.sha);
  expect(c.commit.author).toMatchObject({ name: 'Ada Lovelace', email: people.ada.email });
  expect(c.commit.committer).toMatchObject({ name: 'Live Bridge', email: people['live-bridge'].email });
  expect(c.author.login).toBe('ada');
  expect(await fileOn('main', file)).toContain('line 03 original typed by ada\n');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-base', c.sha);
  // and Forgejo recorded ada as the one who pushed
  const feed = (await forgejoApi('GET', `/repos/${REPO}/activities/feeds?limit=1`)).json[0];
  expect(feed).toMatchObject({ op_type: 'commit_repo', ref_name: 'refs/heads/main' });
  expect(feed.act_user.login).toBe('ada');
  expect(feed.content).toContain(c.sha);

  // Forgejo's own history page of the file shows the commit under her name
  await page.goto(`${BASE}/${REPO}/commits/branch/main/${file}`);
  const row = page.locator('#commits-table tbody tr').first();
  await expect(row).toContainText('Ada Lovelace');
  await expect(row).toContainText(`Live edit ${file}`);
  await expect(row.locator(`a[href$="/commit/${c.sha}"]`).first()).toBeVisible();
  // and the file page renders the new text
  await page.goto(fileUrl(file));
  await expect(page.locator('.file-view')).toContainText('line 03 original typed by ada');
  expect(page.problems).toEqual([]);
  await page.context().close();
});

test('bob joins: both see each other, carets and text; one commit names both', async ({ browser }) => {
  const file = await newFile(agent, 'pair');
  const ada = await signedIn(browser, 'ada');
  const bob = await signedIn(browser, 'bob');
  await openLive(ada, file);
  await openLive(bob, file);
  await expect(ada.getByTestId('person')).toHaveText(['Ada Lovelace (you)', 'Bob Builder']);
  await expect(bob.getByTestId('person')).toHaveText(['Ada Lovelace', 'Bob Builder (you)']);

  await typeAtEndOfLine(ada, 'line 02', ' ada was here', 10);
  await typeAtEndOfLine(bob, 'line 09', ' bob was here', 10);
  // text arrives while it is typed, long before any commit
  await expect.poll(() => editorText(bob)).toContain('line 02 original ada was here');
  await expect.poll(() => editorText(ada)).toContain('line 09 original bob was here');
  // each sees the other's caret, labelled with the name
  await expect(ada.locator('.cm-ySelectionCaret')).toHaveCount(1);
  await expect(bob.locator('.cm-ySelectionCaret')).toHaveCount(1);
  await expect(ada.locator('.cm-ySelectionInfo')).toHaveText('Bob Builder');
  await expect(bob.locator('.cm-ySelectionInfo')).toHaveText('Ada Lovelace');

  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await expect(bob.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  const main = await fileOn('main', file);
  expect(main).toContain('line 02 original ada was here\n');
  expect(main).toContain('line 09 original bob was here\n');
  const c = await lastCommit(file);
  expect(c.commit.author.email).toBe(people.ada.email);
  expect(c.commit.message).toContain(`Co-authored-by: Bob Builder <${people.bob.email}>`);
  expect(await editorText(ada)).toBe(await editorText(bob));
  expect([...ada.problems, ...bob.problems]).toEqual([]);
  await ada.context().close();
  await bob.context().close();
});

test('every view has its own URL: reload, bookmark, back button, full-page variant', async ({ browser }) => {
  const file = await newFile(agent, 'urls');
  const page = await signedIn(browser, 'ada');
  await openLive(page, file);
  const seen = new Set([`${BASE}/user/login`, fileUrl(file), page.url()]);
  expect(page.url()).toBe(liveUrl(file));

  // a reload of the live URL is the live editor again
  await page.reload();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await expect(page.getByTestId('edit-live')).toHaveText('Close live editor');
  // back: Forgejo's rendered file; forward: the editor
  await page.goto(fileUrl(file));
  await page.getByTestId('edit-live').click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await page.goBack();
  await expect(page).toHaveURL(fileUrl(file));
  await expect(page.locator('.file-view')).toBeVisible();
  await expect(page.getByTestId('live-editor')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(liveUrl(file));
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  // "Close live editor" is a link to the file's own URL
  await page.getByTestId('edit-live').click();
  await expect(page).toHaveURL(fileUrl(file));
  await expect(page.locator('.file-view')).toContainText('line 01 original');

  // the same editor as a page of its own, on the same origin, opened directly (a bookmark)
  const other = await page.context().newPage();
  await other.goto(fullPageUrl(file));
  await expect(other.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await expect(other.getByTestId('whoami')).toHaveText(`Ada Lovelace <${people.ada.email}>`);
  await expect(other.getByTestId('host-page')).toHaveAttribute('href', new URL(fileUrl(file)).pathname);
  seen.add(other.url());
  // the file tree of the service links to that page
  await other.goto(`${BASE}/live/r/${REPO}`);
  await expect(other.getByTestId('file-list')).toContainText(file);
  seen.add(other.url());
  expect(seen.size).toBe(5);
  // no button on a file the editor does not handle, or on another branch's pages
  await page.goto(`${BASE}/${REPO}/src/branch/main/src/app.js`);
  await expect(page.locator('.file-view')).toBeVisible();
  await expect(page.getByTestId('edit-live')).toHaveCount(0);
  expect(await branches()).toContain('main');
  await page.context().close();
});
