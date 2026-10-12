// Light check on a repository copied in with scripts/import.mjs (real text, private): one marker
// line typed through "Edit live" becomes a commit in Forgejo's history, and Forgejo's own code
// search finds markdown text. Skipped on a stack without imported repositories; everything heavy
// stays on the synthetic repository.
import { test, expect } from '@playwright/test';
import { BASE, S, enc, forgejoApi, newPage, people, signedIn, typeAtEndOfLine } from './fixtures.js';

const imported = S.accounts.imported || [];
const QUERIES = (process.env.E2E_SEARCH || '').split('|').filter(Boolean);

test.describe('imported repositories', () => {
  test.skip(imported.length === 0, 'no repository was imported into this stack');

  test('a marker line typed into a real markdown file is a commit in Forgejo', async ({ browser }) => {
    const repo = (imported.find((r) => r.markdownFiles < 100) || imported[0]).repo;
    const tree = (await forgejoApi('GET', `/repos/${repo}/git/trees/main?recursive=true&per_page=10000`)).json.tree;
    const file = process.env.E2E_IMPORTED_FILE || tree.find((e) => e.type === 'blob' && /\.md$/i.test(e.path) && e.size > 200 && e.size < 20000).path;
    const page = await signedIn(browser, 'ada');
    await page.goto(`${BASE}/${repo}/src/branch/main/${enc(file)}`);
    await page.getByTestId('edit-live').click();
    const authorize = page.locator('#authorize-app');
    await expect(authorize.or(page.getByTestId('save-state')).first()).toBeVisible();
    if (await authorize.isVisible()) await authorize.click();
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
    const before = await page.evaluate(() => window.__lb.text());
    const marker = `live edit check ${new Date().toISOString()}`;
    const firstLine = before.split('\n').find((l) => l.trim().length > 3);
    await typeAtEndOfLine(page, firstLine, `\n\n${marker}`, 5);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'unsaved');
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved', { timeout: 30000 });

    const c = (await forgejoApi('GET', `/repos/${repo}/commits?sha=main&limit=1&path=${encodeURIComponent(file)}&stat=false&verification=false&files=false`)).json[0];
    expect(c.commit.author.email).toBe(people.ada.email);
    await page.goto(`${BASE}/${repo}/commits/branch/main/${enc(file)}`);
    const row = page.locator('#commits-table tbody tr').first();
    await expect(row).toContainText('Ada Lovelace');
    await expect(row).toContainText(`Live edit ${file}`);
    await page.goto(`${BASE}/${repo}/src/branch/main/${enc(file)}`);
    await expect(page.locator('.file-view')).toContainText(marker);
    // exactly one line more than before, nothing else touched
    const raw = await page.evaluate(async (u) => (await fetch(u)).text(), `/${repo}/raw/branch/main/${enc(file)}`);
    expect(raw.replace(`\n\n${marker}`, '').replace(/\r\n/g, '\n')).toBe(before);
    console.log(`imported repository check: ${BASE}/${repo}/commit/${c.sha} (${file})`);
    await page.context().close();
  });

  test('private: an anonymous visitor does not see an imported repository', async ({ browser }) => {
    const page = await newPage(browser);
    const r = await page.goto(`${BASE}/${imported[0].repo}`);
    expect([404, 200]).toContain(r.status());
    await expect(page.locator('.file-view, #repo-files-table')).toHaveCount(0);
    await page.context().close();
  });

  test('Forgejo code search answers markdown text queries', async ({ browser }) => {
    test.skip(QUERIES.length === 0, 'E2E_SEARCH="word|a phrase|..." names the queries to try');
    const page = await signedIn(browser, 'ada');
    const big = [...imported].sort((a, b) => b.markdownFiles - a.markdownFiles)[0].repo;
    for (const q of QUERIES) {
      for (const mode of ['exact', 'union', 'fuzzy']) {
        const t0 = Date.now();
        await page.goto(`${BASE}/${big}/search?q=${encodeURIComponent(q)}&mode=${mode}`);
        const ms = Date.now() - t0;
        const hits = await page.locator('.repo-search-result, .file-body').count();
        const files = await page.locator('.repo-search-result .header a.file-link, .repo-search-result .header a').evaluateAll((els) => [...new Set(els.map((e) => e.textContent.trim()).filter((t) => /\./.test(t)))].slice(0, 4));
        console.log(`search ${JSON.stringify(q)} mode=${mode}: ${hits} result block(s) on the first page in ${ms} ms; first files: ${files.join(', ')}`);
      }
    }
    await page.context().close();
  });
});
