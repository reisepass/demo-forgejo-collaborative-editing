// Tier 3: real browsers (headless Chromium) on the editor, real git clones as agents.
import { test, expect } from '@playwright/test';
import { DOC, git, lineOf, replaceLine, until } from '../test/helpers.js';
import { editUrl, editorText, openEditor, person, replaceWord, setup, sleep, typeAtEndOfLine } from './fixtures.js';

const worlds = [];
test.afterAll(async () => { for (const w of worlds) await w.stop(); });
async function start(name, opts, worldOpts) {
  const s = await setup(name, opts, worldOpts);
  worlds.push(s.w);
  return s;
}

test('sign-in, file tree and editor each have their own URL; the URL changes on navigation and can be opened directly', async ({ browser }) => {
  const { b } = await start('e-routes', { debounceMs: 800 });
  const context = await browser.newContext();
  const page = await context.newPage();
  // not signed in: a deep link leads to the sign-in page and back to where it pointed
  await page.goto(editUrl(b, 'docs/x.md'));
  await expect(page).toHaveURL(/\/signin\?next=%2Fr%2Flocal%2Fe-routes%2Fedit%2Fdocs%2Fx\.md$/);
  await expect(page.getByTestId('signin-note')).toContainText('Development sign-in');
  await page.getByTestId('signin-name').fill('Ada Human');
  await page.getByTestId('signin-email').fill('ada@humans.test');
  await page.getByTestId('signin-submit').click();
  await expect(page).toHaveURL(editUrl(b, 'docs/x.md'));
  await expect(page.locator('.cm-content')).toContainText('line 20 original');
  await expect(page.getByTestId('whoami')).toHaveText('Ada Human <ada@humans.test>');

  // editor -> tree -> another file, by clicking; the address follows
  await page.getByTestId('back-to-repo').click();
  await expect(page).toHaveURL(`${b.origin}/r/${b.slug}`);
  await expect(page.getByTestId('file-link')).toHaveText(['README.md', 'docs/other.md', 'docs/x.md']);
  const tip = await page.getByTestId('tree-tip').textContent();
  expect(tip).toMatch(/^[0-9a-f]{40}$/);
  await page.getByTestId('file-link').filter({ hasText: 'docs/other.md' }).click();
  await expect(page).toHaveURL(editUrl(b, 'docs/other.md'));
  await expect(page.locator('.cm-content')).toContainText('other file');
  await page.goBack();
  await expect(page).toHaveURL(`${b.origin}/r/${b.slug}`);
  await expect(page.getByTestId('file-list')).toBeVisible();
  // "/" leads to the only repository; a reload of a deep link stays on it
  await page.goto(`${b.origin}/`);
  await expect(page).toHaveURL(`${b.origin}/r/${b.slug}`);
  await page.goto(editUrl(b, 'docs/x.md'));
  await page.reload();
  await expect(page).toHaveURL(editUrl(b, 'docs/x.md'));
  await expect(page.getByTestId('file-path')).toHaveText('docs/x.md');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  // a file that is not there says so on its own URL
  await page.goto(editUrl(b, 'docs/missing.md'));
  await expect(page.getByTestId('page-error')).toContainText('docs/missing.md is not a regular file on main');
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/signin/);
  await context.close();
});

test('two browsers edit one file together: text and cursors with names show up on the other side, and the typing lands on main under the right names', async ({ browser }) => {
  const { w, b } = await start('e-two', { debounceMs: 1000 });
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  const bob = await person(browser, b, 'Bob Human', 'bob@humans.test');
  await openEditor(ada, b);
  await openEditor(bob, b);
  await expect(ada.getByTestId('person')).toHaveText(['Ada Human (you)', 'Bob Human']);
  await expect(bob.getByTestId('person')).toHaveText(['Ada Human', 'Bob Human (you)']);

  await typeAtEndOfLine(ada, 'line 03 ', ' typed by ada', 20);
  await expect(bob.locator('.cm-content')).toContainText('line 03 original typed by ada');
  // Bob sees Ada's caret, labelled with her name, on her line
  const caret = bob.locator('.cm-ySelectionCaret');
  await expect(caret).toHaveCount(1);
  await expect(bob.locator('.cm-ySelectionInfo')).toHaveText('Ada Human');
  const caretLine = await caret.evaluate((el) => el.closest('.cm-line').textContent);
  expect(caretLine).toContain('line 03 original typed by ada');

  await typeAtEndOfLine(bob, 'line 14 ', ' typed by bob', 20);
  await expect(ada.locator('.cm-content')).toContainText('line 14 original typed by bob');
  await expect(ada.locator('.cm-ySelectionInfo')).toHaveText('Bob Human');
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');

  // preview (rendered markdown) follows too
  await expect(bob.getByTestId('preview').locator('h1')).toHaveText('Shared notes');
  await expect(bob.getByTestId('preview')).toContainText('typed by ada');

  const expected = replaceLine(14, 'line 14 original typed by bob')(replaceLine(3, 'line 03 original typed by ada')(DOC));
  await until(async () => (await w.main('docs/x.md')) === expected, 'both edits on main');
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  const tip = await w.tip();
  await expect(ada.getByTestId('save-state')).toContainText(tip);
  await expect(bob.getByTestId('save-state')).toContainText(tip);
  const log = await w.logSince('%an|%ae|%cn|%b');
  expect(log.join('\n')).toContain('Ada Human|ada@humans.test|live-bridge|');
  expect(log.join('\n')).toContain('Bob Human');
  expect(await editorText(ada)).toBe(expected);
  expect(await editorText(bob)).toBe(expected);
  expect(ada.problems).toEqual([]);
  expect(bob.problems).toEqual([]);
});

test('an agent push appears in both editors without a reload, with a notice naming the author and the full commit', async ({ browser }) => {
  const { w, b } = await start('e-agent', { debounceMs: 1500 });
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  const bob = await person(browser, b, 'Bob Human', 'bob@humans.test');
  await openEditor(ada, b);
  await openEditor(bob, b);
  const a = await w.clone('a');
  // Ada is in the middle of line 4 when the agent's commit to line 15 lands
  await typeAtEndOfLine(ada, 'line 04 ', ' human text');
  const commit = await a.change('docs/x.md', replaceLine(15, 'line 15 written by the agent'));
  await expect(ada.locator('.cm-content')).toContainText('line 15 written by the agent');
  await expect(bob.locator('.cm-content')).toContainText('line 15 written by the agent');
  for (const page of [ada, bob]) {
    const notice = page.getByTestId('fold-notice').first();
    await expect(notice).toBeVisible();
    await expect(notice.getByTestId('fold-author')).toHaveText('Agent a');
    await expect(notice.getByTestId('fold-commit')).toHaveText(commit);
    expect(await notice.getByTestId('fold-commit').evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe('ellipsis');
    expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);
  }
  // Ada's caret is still at the end of her text and she goes on typing there
  await ada.keyboard.type(' and more');
  await expect(bob.locator('.cm-content')).toContainText('line 04 original human text and more');
  const expected = replaceLine(15, 'line 15 written by the agent')(replaceLine(4, 'line 04 original human text and more')(DOC));
  await until(async () => (await w.main('docs/x.md')) === expected, 'the human edit on main on top of the agent commit');
  expect(await w.branches()).toEqual([]);
  expect(ada.problems).toEqual([]);
});

test('a clash shows a banner with who changed the line, the full commit and the full conflict branch name', async ({ browser }) => {
  const { w, b } = await start('e-clash', { debounceMs: 5000, holdMs: 700 });
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  const bob = await person(browser, b, 'Bob Human', 'bob@humans.test');
  await openEditor(ada, b);
  await openEditor(bob, b);
  const a = await w.clone('a');
  await replaceWord(ada, 'line 07 original', 'the human rewrote this whole line');
  await typeAtEndOfLine(ada, 'line 12 ', ' human, no clash');
  const humanText = await editorText(ada);
  const commit = await a.change('docs/x.md', replaceLine(7, 'line 07 says something else now, says the agent'));
  for (const page of [ada, bob]) {
    const banner = page.getByTestId('conflict-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId('conflict-author')).toHaveText('Agent a');
    await expect(banner.getByTestId('conflict-main-commit')).toHaveText(commit);
  }
  const branches = await until(async () => { const x = await w.branches(); return x.length ? x : null; }, 'the conflict branch on the host');
  expect(branches).toHaveLength(1);
  expect(branches[0]).toMatch(/^conflict\/ada-human\/docs_x\.md-\d{8}T\d{9}Z$/);
  await expect(ada.getByTestId('conflict-branch')).toHaveText(branches[0]);
  await expect(bob.getByTestId('conflict-branch')).toHaveText(branches[0]);
  await expect(ada.getByTestId('conflict-commit')).toHaveText(await w.tip(branches[0]));
  await expect(ada.getByTestId('conflict-banner')).toContainText('Your complete text from before the merge is kept on branch');
  await expect(bob.getByTestId('conflict-banner')).toContainText("Ada Human's complete text from before the merge is kept on branch");
  // nothing is cut short: the element is as wide as it needs and wraps
  const box = await ada.getByTestId('conflict-branch').evaluate((el) => ({ overflow: getComputedStyle(el).textOverflow, clipped: el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible' }));
  expect(box).toEqual({ overflow: 'clip', clipped: false });
  // the editor shows main's line, keeps the other human edit; the branch holds the human's text
  const merged = replaceLine(12, 'line 12 original human, no clash')(replaceLine(7, 'line 07 says something else now, says the agent')(DOC));
  await expect.poll(() => editorText(ada)).toBe(merged);
  await expect.poll(() => editorText(bob)).toBe(merged);
  expect(await w.main('docs/x.md', branches[0])).toBe(humanText);
  await until(async () => (await w.main('docs/x.md')) === merged, 'the remaining human edit on main', 20000);
  // the banner stays until dismissed, also across a reload
  await ada.reload();
  await expect(ada.getByTestId('conflict-branch')).toHaveText(branches[0]);
  await ada.getByTestId('conflict-banner').getByTestId('dismiss').click();
  await expect(ada.getByTestId('conflict-banner')).toHaveCount(0);
  await ada.reload();
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  await expect(ada.getByTestId('conflict-banner')).toHaveCount(0);
});

test('an ended session is shown as ended; typing starts a new one and nothing typed is dropped', async ({ browser }) => {
  const { w, b } = await start('e-ended', { debounceMs: 700, idleMs: 3000 });
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  await openEditor(ada, b);
  const ended = ada.getByTestId('session-ended');
  await expect(ended).toBeVisible();
  await expect(ended).toContainText('This live session has ended (nobody typed for a while)');
  await expect(ended.getByTestId('ended-base')).toHaveText(await w.tip());
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'ended');
  // main moves; the ended page says it does not follow, and it does not
  const a = await w.clone('a');
  const commit = await a.change('docs/x.md', replaceLine(15, 'line 15 agent edit'));
  await sleep(1000);
  expect(await editorText(ada)).toBe(DOC);

  await typeAtEndOfLine(ada, 'line 02 ', ' typed into the ended session', 15);
  await expect(ended).toHaveCount(0);
  await expect(ada.getByTestId('session-started')).toContainText('A new live session started (number 2)');
  const expected = replaceLine(15, 'line 15 agent edit')(replaceLine(2, 'line 02 original typed into the ended session')(DOC));
  await expect.poll(() => editorText(ada)).toBe(expected);
  await until(async () => (await w.main('docs/x.md')) === expected, 'the text on main');
  expect((await w.commitInfo(await w.tip())).parents).toEqual([commit]);
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');

  // ended again; the Resume button starts a session without typing and catches up with main
  await expect(ada.getByTestId('session-ended')).toBeVisible();
  const commit2 = await a.change('docs/x.md', replaceLine(16, 'line 16 agent edit'));
  await ada.getByTestId('resume').click();
  await expect(ada.locator('.cm-content')).toContainText('line 16 agent edit');
  await expect(ada.getByTestId('fold-commit').first()).toHaveText(commit2);
  expect(ada.problems).toEqual([]);
});

test('byte-exact in a real browser: opening and leaving makes no commit; a one-word edit changes exactly one line (CRLF, no final newline)', async ({ browser }) => {
  const crlf = '# Windows file\r\n\r\nfirst line\r\nsecond line\r\nthird line\r\n';
  const noeol = '# No newline at the end\n\nalpha\nbeta\ngamma';
  const agentStyle = '# Written by an agent\n\n* star bullet\n- dash bullet\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\n\nThree blank lines above, two spaces at the end here  \n<details>raw html</details>\n\\*escaped\\* and __underscores__ and a very long line that an editor might want to wrap but must not because the file belongs to someone else who chose this\n';
  const { w, b } = await start('e-bytes', { debounceMs: 500, emptyMs: 400 }, { files: { 'docs/crlf.md': crlf, 'docs/noeol.md': noeol, 'docs/agent.md': agentStyle } });
  const before = await w.tip();
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  for (const f of ['docs/crlf.md', 'docs/noeol.md', 'docs/agent.md']) {
    await openEditor(ada, b, f);
    await ada.locator('.cm-content').click();
    await ada.keyboard.press('ArrowDown');
    await ada.keyboard.press('End');
  }
  await ada.goto(`${b.origin}/r/${b.slug}`);
  await until(() => b.count('session-close') === 3, 'the three sessions to end');
  expect(await w.tip()).toBe(before);
  expect(b.count('flush')).toBe(0);

  const cases = [['docs/crlf.md', crlf, 'second', 'SECOND'], ['docs/noeol.md', noeol, 'beta', 'BETA'], ['docs/agent.md', agentStyle, 'dash', 'DASH']];
  for (const [f, original, from, to] of cases) {
    await openEditor(ada, b, f);
    await replaceWord(ada, from, to);
    const fl = await b.waitFor('flush', (e) => e.path === f);
    expect(await w.main(f)).toBe(original.replace(from, to));
    expect((await git(w.bare, ['show', '--numstat', '--format=', fl.commit])).trim()).toBe(`1\t1\t${f}`);
    await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  }
  // Enter in the CRLF file makes a CRLF line; typing after the last line of the other adds no newline
  await openEditor(ada, b, 'docs/crlf.md');
  await typeAtEndOfLine(ada, 'first line', '');
  await ada.keyboard.press('Enter');
  await ada.keyboard.type('added line');
  await b.waitFor('flush', (e) => e.path === 'docs/crlf.md' && e.added === 1 && e.removed === 0);
  expect(await w.main('docs/crlf.md')).toBe(crlf.replace('second', 'SECOND').replace('first line\r\n', 'first line\r\nadded line\r\n'));
  await openEditor(ada, b, 'docs/noeol.md');
  await typeAtEndOfLine(ada, 'gamma', ' ray');
  await b.waitFor('flush', (e) => e.path === 'docs/noeol.md' && e.commit !== undefined && b.of('flush').filter((x) => x.path === 'docs/noeol.md').length === 2);
  expect(await w.main('docs/noeol.md')).toBe(noeol.replace('beta', 'BETA') + ' ray');
  expect(ada.problems).toEqual([]);
});

test('the service is killed and started again: the browser says so, keeps what is typed, reconnects by itself, and the text lands on main', async ({ browser }) => {
  const { w, b } = await start('e-restart', { debounceMs: 3000 });
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  await openEditor(ada, b);
  await typeAtEndOfLine(ada, 'line 05 ', ' typed before the kill');
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
  await b.kill('SIGKILL');
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'offline');
  await expect(ada.getByTestId('save-state')).toContainText('Not connected to the service');
  await typeAtEndOfLine(ada, 'line 06 ', ' typed while the service was dead');
  await expect(ada.getByTestId('save-state')).toContainText('What you typed stays in this tab');
  const b2 = await w.startBridge({ debounceMs: 800, port: b.port });
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved', { timeout: 30000 });
  const expected = replaceLine(6, 'line 06 original typed while the service was dead')(replaceLine(5, 'line 05 original typed before the kill')(DOC));
  expect(await w.main('docs/x.md')).toBe(expected);
  expect(await editorText(ada)).toBe(expected);
  expect(await ada.evaluate(() => window.__neverReloaded)).toBe(true);
  expect(lineOf(await b2.fresh(), 5)).toBe('line 05 original typed before the kill');
});

test('the service no longer has the document a tab holds: unconfirmed text goes to a branch named in the tab, and the tab starts over from main', async ({ browser }) => {
  const { w, b } = await start('e-orphan', { debounceMs: 800 });
  const ada = await person(browser, b, 'Ada Human', 'ada@humans.test');
  await openEditor(ada, b);
  // the tab loses its connection and its owner keeps typing
  await ada.evaluate(() => { window.__lb.client.closed = true; window.__lb.client.drop(); });
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'offline');
  await typeAtEndOfLine(ada, 'line 05 ', ' typed in a tab that was cut off');
  const tabText = await editorText(ada);
  // meanwhile the file is removed on main and created again: the old document is gone for good
  const a = await w.clone('a');
  await a.pull();
  await a.git(['rm', '--quiet', 'docs/x.md']);
  await a.git(['commit', '--quiet', '-m', 'remove']);
  await a.push();
  await until(async () => (await b.status()).sessions.length === 0, 'the room to be dropped');
  a.write('docs/x.md', '# A new file under the old name\n\nfresh content\n');
  await a.git(['add', '-A']);
  await a.git(['commit', '--quiet', '-m', 'create again']);
  await a.push();
  await ada.evaluate(() => { window.__lb.client.closed = false; window.__lb.client.connect(); });
  const banner = ada.getByTestId('orphan-banner');
  await expect(banner).toBeVisible();
  const branches = await w.branches();
  expect(branches).toHaveLength(1);
  await expect(banner.getByTestId('conflict-branch')).toHaveText(branches[0]);
  await expect(banner.getByTestId('conflict-commit')).toHaveText(await w.tip(branches[0]));
  expect(await w.main('docs/x.md', branches[0])).toBe(tabText);
  expect(await editorText(ada)).toBe('# A new file under the old name\n\nfresh content\n');
  await expect(ada.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  expect(await w.main('docs/x.md')).toBe('# A new file under the old name\n\nfresh content\n');
});
