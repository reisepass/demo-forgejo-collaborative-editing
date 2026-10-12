// Shared by the specs: the running stack, people who sign in through Forgejo's own form, the
// agent (a clone driven by the real git command), and looks at Forgejo through its API.
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, git, sleep, stackInfo, file as homeFile } from '../scripts/lib.mjs';

export { sleep };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const S = stackInfo();
if (!S) throw new Error('the stack is not set up (global-setup.js starts it)');
export const REPO = S.repo;
export const BASE = S.publicUrl;
export const people = S.accounts.people;
export const asRoot = { token: people.root.token };

export const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
export const fileUrl = (file) => `${BASE}/${REPO}/src/branch/main/${enc(file)}`;
export const liveUrl = (file) => `${fileUrl(file)}?live=1`;
export const fullPageUrl = (file) => `${BASE}/live/r/${REPO}/edit/${enc(file)}`;

/** Runs scripts/up.sh or scripts/down.sh for one part of the stack, with extra environment. */
export function stackScript(script, args = [], env = {}) {
  execFileSync('sh', [path.join(ROOT, 'scripts', `${script}.sh`), ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
}

/** Restarts the editor service with other settings (for example without the demand-flush hook). */
export function restartService(env = {}) {
  stackScript('down', ['--only', 'service']);
  stackScript('up', ['--only', 'service', '--quiet'], env);
}

// ---------------------------------------------------------------- people

/** A new browser context with a page that collects script errors. */
export async function newPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) page.problems.push(`console: ${m.text()}`); });
  return page;
}

/** Fills in Forgejo's own sign-in form on the page that is showing it. */
export async function fillSignIn(page, user) {
  await page.locator('input[name="user_name"]').fill(user);
  await page.locator('input[name="password"]').fill(people[user].password);
  await page.locator('input[name="password"]').press('Enter');
}

/** A new browser context signed in to Forgejo as this person, through the form. */
export async function signedIn(browser, user) {
  const page = await newPage(browser);
  await page.goto(`${BASE}/user/login`);
  await fillSignIn(page, user);
  await expect(page).not.toHaveURL(/\/user\/login/);
  return page;
}

/** Forgejo asks once per person whether the editor may act for them. */
async function consentIfAsked(page) {
  const authorize = page.locator('#authorize-app');
  const editor = page.getByTestId('save-state');
  await expect(authorize.or(editor).first()).toBeVisible();
  if (await authorize.isVisible()) await authorize.click();
}

/** Opens Forgejo's page of the file, presses "Edit live" and waits until the editor is in step with the service. */
export async function openLive(page, file, { phase = 'saved' } = {}) {
  await page.goto(fileUrl(file));
  await page.getByTestId('edit-live').click();
  await consentIfAsked(page);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-phase', phase);
  await expect(page).toHaveURL(liveUrl(file));
  // a sentinel that a reload would wipe
  await page.evaluate(() => { window.__neverReloaded = true; });
}

export const editorText = (page) => page.evaluate(() => window.__lb.text());

/** Puts the caret at the end of the first line that starts with `prefix`, then types with the real keyboard. */
export async function typeAtEndOfLine(page, prefix, text, delay = 0) {
  await page.locator('.cm-content').click();
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

// ---------------------------------------------------------------- the agent and Forgejo's view

export class Agent {
  constructor(dir) { this.dir = dir; this.who = people.agent; }
  git(args, opts) { return git(this.dir, args, opts); }
  read(file) { return readFileSync(path.join(this.dir, file), 'utf8'); }
  write(file, text) { mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true }); writeFileSync(path.join(this.dir, file), text); }
  async pull() { await this.git(['pull', '--quiet', '--rebase', 'origin', 'main']); }
  async commit(file, fn, message = `agent: edit ${file}`) {
    this.write(file, fn(this.read(file)));
    await this.git(['add', '--', file]);
    await this.git(['commit', '--quiet', '-m', message]);
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }
  /** One plain push, no retry. Resolves with {code, stderr, ms}. */
  async pushOnce() {
    const t0 = performance.now();
    const r = await this.git(['push', 'origin', 'HEAD:main'], { allowFail: true });
    return { ...r, ms: performance.now() - t0 };
  }
  /** Pull, edit, commit, push; returns the commit. */
  async change(file, fn, message) {
    await this.pull();
    const commit = await this.commit(file, fn, message);
    const r = await this.pushOnce();
    if (r.code !== 0) throw new Error(`agent push failed: ${r.stderr}`);
    return commit;
  }
}

/** A fresh clone for the agent, made through the public address like any outside git client. */
export async function agentClone(name = 'agent') {
  mkdirSync(homeFile('agents'), { recursive: true });
  const dir = mkdtempSync(homeFile('agents', `${name}-`));
  const who = people.agent;
  await git(dir, ['clone', '--quiet', `http://${who.user}:${who.token}@127.0.0.1:${S.ports.proxy}/${REPO}.git`, '.']);
  await git(dir, ['config', 'user.name', who.fullName]);
  await git(dir, ['config', 'user.email', who.email]);
  return new Agent(dir);
}

export const DOC = (title) => `# ${title}\n\n${Array.from({ length: 12 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} original`).join('\n')}\n`;

let fileSeq = 0;
/** A new markdown file on main for one test, pushed by the agent. Returns its path. */
export async function newFile(agent, label, text = null) {
  const file = `e2e/${label}-${Date.now().toString(36)}${++fileSeq}.md`;
  await agent.pull();
  agent.write(file, text ?? DOC(label));
  await agent.git(['add', '--', file]);
  await agent.git(['commit', '--quiet', '-m', `agent: add ${file}`]);
  const r = await agent.pushOnce();
  if (r.code !== 0) throw new Error(`agent push failed: ${r.stderr}`);
  return file;
}

export const forgejoApi = (method, route, opts = {}) => api(S.forgejoUrl, method, route, { as: asRoot, ...opts });

/** Text of a file on a branch, as Forgejo serves it. */
export async function fileOn(branch, file) {
  const r = await fetch(`${S.forgejoUrl}/${REPO}/raw/branch/${enc(branch)}/${enc(file)}`, { headers: { authorization: `token ${people.root.token}` } });
  return r.ok ? r.text() : null;
}

/** Newest commit of main that touched `file`, from Forgejo's API. */
export async function lastCommit(file) {
  const r = await forgejoApi('GET', `/repos/${REPO}/commits?sha=main&limit=1&path=${encodeURIComponent(file)}&stat=false&verification=false&files=false`);
  return r.json[0];
}

export async function mainTip() {
  return (await forgejoApi('GET', `/repos/${REPO}/branches/main`)).json.commit.id;
}

export async function branches() {
  return (await forgejoApi('GET', `/repos/${REPO}/branches?limit=50`)).json.map((b) => b.name);
}

export const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

export async function serviceStatus() {
  const r = await fetch(`${S.serviceUrl}/live/api/status`);
  return (await r.json()).repos[0];
}
