// Shared by the browser specs: a world (bare repository, service, agents) and signed-in pages.
import { expect } from '@playwright/test';
import { makeWorld } from '../test/helpers.js';
import { signIn } from '../test/human.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(name, bridgeOpts = {}, worldOpts = undefined) {
  const w = await makeWorld(name, worldOpts);
  const b = await w.startBridge(bridgeOpts);
  return { w, b };
}

/** A new browser context signed in as this person (the token is put where the sign-in form puts it). */
export async function person(browser, b, name, email) {
  const token = await signIn(b.origin, name, email);
  const context = await browser.newContext();
  await context.addInitScript(([t, u]) => { localStorage.setItem('lb.token', t); localStorage.setItem('lb.user', u); }, [token, JSON.stringify({ name, email })]);
  const page = await context.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
  return page;
}

export const editUrl = (b, file) => `${b.origin}/r/${b.slug}/edit/${file.split('/').map(encodeURIComponent).join('/')}`;

/** Opens the editor on a file and waits until it is connected and in step with the service. */
export async function openEditor(page, b, file = 'docs/x.md') {
  await page.goto(editUrl(b, file));
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', 'saved');
  // a sentinel that a reload would wipe
  await page.evaluate(() => { window.__neverReloaded = true; });
}

export const editorText = (page) => page.evaluate(() => window.__lb.view.state.doc.toString());

/** Puts the caret at the end of the first line that starts with `prefix`, then types with the real keyboard. */
export async function typeAtEndOfLine(page, prefix, text, delay = 0) {
  await page.evaluate((p) => {
    const v = window.__lb.view;
    const doc = v.state.doc.toString();
    const at = doc.indexOf(p);
    if (at === -1) throw new Error(`no line starts with ${p}`);
    const nl = doc.indexOf('\n', at);
    v.focus();
    v.dispatch({ selection: { anchor: nl === -1 ? doc.length : nl }, scrollIntoView: true });
  }, prefix);
  await page.keyboard.type(text, { delay });
}

/** Selects the first occurrence of `word` and types `replacement` over it with the real keyboard. */
export async function replaceWord(page, word, replacement) {
  await page.evaluate((wd) => {
    const v = window.__lb.view;
    const at = v.state.doc.toString().indexOf(wd);
    if (at === -1) throw new Error(`no ${wd} in the text`);
    v.focus();
    v.dispatch({ selection: { anchor: at, head: at + wd.length }, scrollIntoView: true });
  }, word);
  await page.keyboard.type(replacement);
}
