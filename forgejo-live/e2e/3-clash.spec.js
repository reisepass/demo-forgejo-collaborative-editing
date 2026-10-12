// What happens when an agent's push meets text a person has typed and that is not on main yet.
//
// With the demand-flush hook (the default of the stack): Forgejo's pre-receive asks the service,
// the person's text is committed first, and the agent's push is turned away once. The agent sees
// an ordinary rejected push and rebases onto the person's text.
//
// Without the hook: the push lands. Where it changed the very lines the person changed, main
// keeps the agent's lines, the editor takes them, a banner says so, and the person's complete
// text is kept on a conflict branch that Forgejo shows like any other branch.
import { test, expect } from '@playwright/test';
import {
  BASE, REPO, agentClone, branches, editorText, enc, fileOn, forgejoApi, lastCommit, newFile, openLive, people, restartService, serviceStatus, signedIn, sleep, typeAtEndOfLine,
} from './fixtures.js';
import { TEST_ENV } from './global-setup.js';

// a long typing pause, so "typed but not on main yet" lasts as long as the test needs it
const SLOW = { LIVE_DEBOUNCE_MS: '60000', LIVE_MAX_WAIT_MS: '120000' };

test.describe('with the demand-flush hook', () => {
  test.beforeAll(() => restartService(SLOW));
  test.afterAll(() => restartService(TEST_ENV));

  test('the push is turned away once, the agent rebases onto the person\'s text, both end up on main', async ({ browser }) => {
    const agent = await agentClone('demand');
    const file = await newFile(agent, 'demand');
    const page = await signedIn(browser, 'ada');
    await openLive(page, file);
    const base = await lastCommit(file);

    await agent.pull();
    await typeAtEndOfLine(page, 'line 04', ' typed by ada and not saved yet', 5);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
    await sleep(300);
    expect((await lastCommit(file)).sha, 'nothing was committed by the typing pause').toBe(base.sha);

    // the agent changes another line of the same file and pushes: plain git, no retry logic
    const mine = await agent.commit(file, (t) => t.replace('line 09 original', 'line 09 by the agent'));
    const first = await agent.pushOnce();
    expect(first.code).not.toBe(0);
    expect(first.stderr).toContain('pre-receive hook declined');
    expect(first.stderr).toMatch(new RegExp(`bridge: ${file.replace(/[.]/g, '\\.')} is being edited live by Ada Lovelace <${people.ada.email}>; their text was just saved to main as [0-9a-f]{40}`));
    expect(first.stderr).toContain('git pull --rebase');

    // ada's text is on main now, under her name, and the agent's commit is not
    const saved = await lastCommit(file);
    expect(saved.commit.author.email).toBe(people.ada.email);
    expect(await fileOn('main', file)).toContain('line 04 original typed by ada and not saved yet\n');
    expect(await fileOn('main', file)).toContain('line 09 original\n');
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');

    // what any git user does after a rejected push
    await agent.pull();
    expect(agent.read(file)).toContain('line 04 original typed by ada and not saved yet\n');
    const second = await agent.pushOnce();
    expect(second.code, second.stderr).toBe(0);
    expect((await agent.git(['rev-parse', 'HEAD'])).trim()).not.toBe(mine);

    await expect.poll(() => editorText(page)).toContain('line 09 by the agent');
    const main = await fileOn('main', file);
    expect(main).toContain('line 04 original typed by ada and not saved yet\n');
    expect(main).toContain('line 09 by the agent\n');
    expect(await editorText(page)).toBe(main);
    await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
    expect((await branches()).filter((b) => b.startsWith('conflict/') && b.includes('demand'))).toEqual([]);
    expect((await serviceStatus()).counters.demandFlushes).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);
    expect(page.problems).toEqual([]);
    await page.context().close();
  });

  test('a push that touches no file with unsaved text goes straight through', async ({ browser }) => {
    const agent = await agentClone('bystander');
    const file = await newFile(agent, 'busy');
    const other = await newFile(agent, 'quiet');
    const page = await signedIn(browser, 'ada');
    await openLive(page, file);
    await typeAtEndOfLine(page, 'line 04', ' unsaved', 5);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
    await agent.pull();
    await agent.commit(other, (t) => `${t}one more line\n`);
    const r = await agent.pushOnce();
    expect(r.code, r.stderr).toBe(0);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
    expect(await fileOn('main', file)).not.toContain('unsaved');
    await page.context().close();
  });
});

test.describe('without the hook', () => {
  test.beforeAll(() => restartService({ ...SLOW, LIVE_NO_DEMAND_FLUSH: '1' }));
  test.afterAll(() => restartService(TEST_ENV));

  test('a clash shows a banner and the person\'s text is on a conflict branch that Forgejo shows', async ({ browser }) => {
    const agent = await agentClone('clash');
    const file = await newFile(agent, 'clash');
    const page = await signedIn(browser, 'ada');
    await openLive(page, file);

    await agent.pull();
    const theirs = await agent.commit(file, (t) => t.replace('line 05 original', 'line 05 rewritten by the agent'));
    await typeAtEndOfLine(page, 'line 05', ' and ada added this', 5);
    await typeAtEndOfLine(page, 'line 08', ' ada, another line', 5);
    const pushed = await agent.pushOnce();
    expect(pushed.code, pushed.stderr).toBe(0);

    // main's line wins in the editor, ada's other line stays
    await expect.poll(() => editorText(page)).toContain('line 05 rewritten by the agent\n');
    expect(await editorText(page)).not.toContain('and ada added this');
    expect(await editorText(page)).toContain('line 08 original ada, another line\n');

    const banner = page.getByTestId('conflict-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId('conflict-author')).toHaveText('Coding Agent');
    await expect(banner.getByTestId('conflict-main-commit')).toHaveText(theirs);
    const branch = await banner.getByTestId('conflict-branch').textContent();
    expect(branch).toMatch(/^conflict\/ada[^/]*\/.*clash.*Z$/i);
    await expect(banner).toContainText('Your complete text from before the merge is kept on branch');
    // the banner shows the branch name and the commits in full, never shortened
    expect((await banner.textContent()).includes('…')).toBe(false);

    // Forgejo knows the branch (it went through Forgejo, pushed as ada) ...
    await expect.poll(() => branches()).toContain(branch);
    const onBranch = await fileOn(branch, file);
    expect(onBranch).toContain('line 05 original and ada added this\n');
    expect(onBranch).toContain('line 08 original ada, another line\n');
    const tip = (await forgejoApi('GET', `/repos/${REPO}/branches/${encodeURIComponent(branch)}`)).json.commit;
    expect(tip.author.email).toBe(people.ada.email);
    expect(tip.id).toBe(await banner.getByTestId('conflict-commit').textContent());
    // ... and shows it: the banner links to Forgejo's page of that branch, with ada's text
    await expect(banner.getByTestId('conflict-branch')).toHaveAttribute('href', `/${REPO}/src/branch/${enc(branch)}`);
    const branchPage = await page.context().newPage();
    await branchPage.goto(`${BASE}/${REPO}/src/branch/${enc(branch)}/${enc(file)}`);
    await expect(branchPage.locator('.file-view')).toContainText('line 05 original and ada added this');
    await branchPage.goto(`${BASE}/${REPO}/branches`);
    await expect(branchPage.locator('body')).toContainText(branch);

    expect(await fileOn('main', file)).toContain('line 05 rewritten by the agent\n');
    expect(await page.evaluate(() => window.__neverReloaded)).toBe(true);
    expect(page.problems).toEqual([]);
    await page.context().close();
  });
});
