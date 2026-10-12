// Records the demo clip: two people in two browsers on the same Forgejo file page, typing at
// once, then a plain `git push` by an agent arriving in both editors, then Forgejo's history.
// Needs the stack running (scripts/up.sh) and ffmpeg on the PATH.
//
//   FORGEJO_LIVE_HOME=<the stack's folder> node scripts/record-demo.mjs <output folder>
//
// Writes demo.mp4, demo.gif and timeline.json into the output folder. Nothing is sped up or cut
// except the first moments while the pages load. The two pages are recorded headless, so the
// window frames, address bars and mouse pointers are drawn: the frames by a third recorded page
// that follows each page's real address and title, the pointer by a script in the page.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log, sleep, stackInfo } from './lib.mjs';

const OUT = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('usage: node scripts/record-demo.mjs <output folder>');
mkdirSync(OUT, { recursive: true });

const S = stackInfo();
if (!S) throw new Error('the stack is not set up; run scripts/up.sh first');
const BASE = S.publicUrl;
const REPO = S.repo;
const people = S.accounts.people;
const FILE = `docs/handbook/release-checklist-${Date.now().toString(36)}.md`;
const FILE_URL = `${BASE}/${REPO}/src/branch/main/${FILE}`;
const PANE = { width: 880, height: 720 };
const GAP = 24;
const CHROME = 76; // tab row and address row of a drawn window
const BAND = 150; // caption and the agent's terminal
const CANVAS = { width: GAP * 3 + PANE.width * 2, height: GAP + CHROME + PANE.height + 16 + BAND + GAP };
const AT = { ada: { x: GAP, y: GAP + CHROME }, bob: { x: GAP * 2 + PANE.width, y: GAP + CHROME } };

const TEXT = `# Release checklist

## Before the release

- [x] Changelog written

## Notes

## From the build agent

`;

// ---------------------------------------------------------------- the agent: real git

const scrub = (s) => s.split(people.agent.token).join('<token>');
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${scrub(r.stderr)}`);
  return scrub(`${r.stdout}${r.stderr}`).trim();
}
const agentDir = mkdtempSync(path.join(OUT, 'agent-'));
git(agentDir, ['clone', '--quiet', `http://${people.agent.user}:${people.agent.token}@127.0.0.1:${S.ports.proxy}/${REPO}.git`, '.']);
git(agentDir, ['config', 'user.name', people.agent.fullName]);
git(agentDir, ['config', 'user.email', people.agent.email]);
mkdirSync(path.dirname(path.join(agentDir, FILE)), { recursive: true });
writeFileSync(path.join(agentDir, FILE), TEXT);
git(agentDir, ['add', '--', FILE]);
git(agentDir, ['commit', '--quiet', '-m', 'Add release checklist']);
git(agentDir, ['push', '--quiet', 'origin', 'HEAD:main']);
log.info(`demo file on main: ${FILE}`);

// ---------------------------------------------------------------- sign-in, outside the recording

const browser = await chromium.launch();

async function signInState(user) {
  const context = await browser.newContext({ viewport: PANE });
  const page = await context.newPage();
  await page.goto(`${BASE}/user/login`);
  await page.locator('input[name="user_name"]').fill(user);
  await page.locator('input[name="password"]').fill(people[user].password);
  await page.locator('input[name="password"]').press('Enter');
  await page.waitForURL((u) => !/\/user\/login/.test(u.toString()));
  // once through the editor so Forgejo's "Authorize application" page is not in the clip
  await page.goto(FILE_URL);
  await page.getByTestId('edit-live').click();
  const authorize = page.locator('#authorize-app');
  const state = page.getByTestId('save-state');
  await authorize.or(state).first().waitFor();
  if (await authorize.isVisible()) await authorize.click();
  await page.locator('[data-testid=save-state][data-phase=saved]').waitFor();
  const stored = await context.storageState();
  await context.close();
  return stored;
}
const states = { ada: await signInState('ada'), bob: await signInState('bob') };

// ---------------------------------------------------------------- the recording

const win = (who, name, colour) => `<div class="win" style="left:${AT[who].x}px;top:${GAP}px">
  <div class="tabs"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <div class="tab"><b>F</b><span id="title-${who}">New Tab</span></div></div>
  <div class="bar"><span class="nav">&#8592; &#8594; &#8635;</span><div class="url" id="url-${who}"></div>
    <div class="me" style="background:${colour}">${name[0]}</div><span class="name">${name}</span></div></div>`;
const DESK_HTML = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; overflow: hidden; font: 13px/1.3 -apple-system, "Segoe UI", sans-serif; background: linear-gradient(135deg, #2b3a55, #1c2333 60%, #2a2440); }
  .win { position: absolute; width: ${PANE.width}px; height: ${CHROME + PANE.height}px; background: #fff; border-radius: 10px 10px 0 0; box-shadow: 0 12px 40px rgba(0,0,0,.55); overflow: hidden; }
  .tabs { height: 36px; background: #dee1e6; display: flex; align-items: flex-end; padding-left: 12px; }
  .tabs i { width: 12px; height: 12px; border-radius: 50%; margin: 0 8px 12px 0; }
  .tab { margin-left: 10px; height: 28px; width: 620px; background: #fff; border-radius: 8px 8px 0 0; display: flex; align-items: center; padding: 0 10px; gap: 8px; color: #333; font-size: 12px; white-space: nowrap; overflow: hidden; }
  .tab b { color: #fff; background: #c2410c; border-radius: 3px; width: 16px; height: 16px; font-size: 11px; text-align: center; line-height: 16px; flex: none; }
  .bar { height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid #d5d8dd; box-sizing: border-box; color: #5f6368; }
  .nav { font-size: 16px; letter-spacing: 6px; }
  .url { flex: 1; height: 26px; line-height: 26px; background: #f1f3f4; border-radius: 13px; padding: 0 14px; color: #202124; font-size: 11.5px; white-space: nowrap; overflow: hidden; }
  .me { width: 24px; height: 24px; border-radius: 50%; color: #fff; text-align: center; line-height: 24px; font-weight: 600; }
  .name { color: #333; font-size: 12px; }
  #caption { position: absolute; left: ${GAP}px; top: ${GAP + CHROME + PANE.height + 16}px; width: ${PANE.width}px; height: ${BAND}px; display: flex; align-items: center; color: #f2f4f8; font-size: 26px; font-weight: 600; }
  #termwin { position: absolute; left: ${AT.bob.x}px; top: ${GAP + CHROME + PANE.height + 16}px; width: ${PANE.width}px; height: ${BAND}px; background: #0b0c0f; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.5); overflow: hidden; }
  #termwin .t { height: 22px; background: #2a2d34; color: #aab1bd; font-size: 11px; line-height: 22px; text-align: center; }
  #term { margin: 0; padding: 8px 14px; color: #b8f0b0; font: 12.5px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
</style>${win('ada', 'Ada', '#c2410c')}${win('bob', 'Bob', '#1d6fb8')}
<div id="caption"></div><div id="termwin"><div class="t">agent@build-vm: ~/handbook</div><pre id="term">$ </pre></div>`;

// A pointer drawn inside the page: headless recordings have none.
const POINTER = () => {
  const put = () => {
    if (document.getElementById('__pointer')) return;
    const p = document.createElement('div');
    p.id = '__pointer';
    p.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:18px;height:24px;left:-40px;top:-40px;'
      + "background:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='24'%3E%3Cpath d='M1 1v19l5-4 3 7 3-1.4-3-6.6h7z' fill='black' stroke='white' stroke-width='1.3'/%3E%3C/svg%3E\") no-repeat";
    document.documentElement.appendChild(p);
    const move = (x, y) => { p.style.left = `${x}px`; p.style.top = `${y}px`; sessionStorage.setItem('__pointer', `${x},${y}`); };
    const last = (sessionStorage.getItem('__pointer') || '').split(',');
    if (last.length === 2) move(Number(last[0]), Number(last[1]));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
  };
  if (document.documentElement) put();
  document.addEventListener('DOMContentLoaded', put);
};

async function recorded(size, storageState) {
  const context = await browser.newContext({ viewport: size, storageState, recordVideo: { dir: OUT, size } });
  if (storageState) await context.addInitScript(POINTER);
  return context.newPage();
}
const [ada, bob, desk] = await Promise.all([recorded(PANE, states.ada), recorded(PANE, states.bob), recorded(CANVAS)]);
const t0 = Date.now();
const timeline = [];
await desk.setContent(DESK_HTML);
const set = (id, text) => desk.evaluate(([i, t]) => { document.getElementById(i).textContent = t; }, [id, text]).catch(() => {});
async function caption(text) {
  timeline.push({ atMs: Date.now() - t0, caption: text });
  await set('caption', text);
}
// the drawn windows show each page's real address and title
const follow = setInterval(async () => {
  for (const [who, page] of [['ada', ada], ['bob', bob]]) {
    const url = page.url();
    await set(`url-${who}`, url === 'about:blank' ? '' : url.replace(/^http:\/\//, ''));
    const title = await page.title().catch(() => '');
    if (title) await set(`title-${who}`, title);
  }
}, 150);

// ---- hands: a pointer that travels, and typing with an uneven rhythm, slips and pauses

const rand = (a, b) => a + Math.random() * (b - a);
const pointer = new Map([[ada, { x: 620, y: 420 }], [bob, { x: 300, y: 500 }]]);
async function moveTo(page, x, y) {
  const from = pointer.get(page);
  const steps = Math.max(12, Math.round(Math.hypot(x - from.x, y - from.y) / 14));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2; // ease in and out
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(rand(8, 18));
  }
  pointer.set(page, { x, y });
}
async function pointAt(page, locator) {
  const box = await locator.boundingBox();
  await moveTo(page, box.x + box.width * rand(0.35, 0.65), box.y + box.height * rand(0.4, 0.6));
}
async function clickOn(page, locator) {
  await pointAt(page, locator);
  await sleep(rand(180, 420));
  const at = pointer.get(page);
  await page.mouse.click(at.x, at.y);
}
/** Clicks with the pointer just right of the end of the line that holds `text`. */
async function clickLineEnd(page, text) {
  const at = await page.evaluate((t) => {
    const v = window.__lb.view;
    const doc = v.state.doc.toString();
    const i = doc.indexOf(t);
    if (i === -1) throw new Error(`no line ${t}`);
    const c = v.coordsAtPos(doc.indexOf('\n', i));
    return { x: c.right + 30, y: (c.top + c.bottom) / 2 };
  }, text);
  await moveTo(page, at.x, at.y);
  await sleep(rand(150, 350));
  await page.mouse.click(at.x, at.y);
}
const NEAR = { a: 's', s: 'd', e: 'r', r: 't', t: 'r', i: 'o', o: 'p', n: 'm', l: 'k', g: 'h', h: 'j', c: 'v', d: 'f' };
async function humanType(page, text, base) {
  for (const ch of text) {
    if (NEAR[ch] && Math.random() < 0.035) {
      await page.keyboard.type(NEAR[ch]);
      await sleep(rand(220, 420));
      await page.keyboard.press('Backspace');
      await sleep(rand(110, 220));
    }
    await page.keyboard.type(ch);
    let wait = base * rand(0.45, 1.5);
    if (ch === ' ') wait += rand(0, 110);
    if (/[,.:]/.test(ch)) wait += rand(220, 480);
    if (Math.random() < 0.04) wait += rand(350, 800);
    await sleep(wait);
  }
}
async function terminalType(text, shown) {
  let line = '';
  for (const ch of text) {
    line += ch;
    await set('term', `${shown}$ ${line}`);
    await sleep(rand(25, 70));
  }
  return `${shown}$ ${line}\n`;
}
const saved = (page) => page.locator('[data-testid=save-state][data-phase=saved]').waitFor();

await caption('Ada and Bob open the same markdown file in Forgejo');
await ada.goto(FILE_URL);
await sleep(rand(900, 1400));
await bob.goto(FILE_URL);
await moveTo(ada, 500, 330);
await sleep(1800);

await caption('Each presses "Edit live" on the file page');
await clickOn(ada, ada.getByTestId('edit-live'));
await saved(ada);
await sleep(rand(500, 900));
await moveTo(bob, 420, 380);
await sleep(rand(400, 800));
await clickOn(bob, bob.getByTestId('edit-live'));
await saved(bob);
await sleep(1200);

await caption('Ada starts typing, Bob joins in further down');
// the editor continues a task list after Enter, so the items are typed without their marker
const adaTypes = async () => {
  await clickLineEnd(ada, '- [x] Changelog written');
  await sleep(rand(300, 600));
  await ada.keyboard.press('Enter');
  await humanType(ada, 'Tag the release candidate', 82);
  await sleep(rand(1100, 1700));
  await ada.keyboard.press('Enter');
  await humanType(ada, 'Tell support what changed', 82);
};
const bobTypes = async () => {
  await sleep(rand(3200, 3900)); // watches Ada's first words arrive
  await clickLineEnd(bob, '## Notes');
  await sleep(rand(400, 700));
  await bob.keyboard.press('Enter');
  await sleep(rand(150, 300));
  await bob.keyboard.press('Enter');
  await sleep(rand(300, 600));
  await humanType(bob, 'Bob: staging looks good, fine with shipping on Friday.', 105);
};
await Promise.all([adaTypes(), bobTypes()]);
await sleep(1000);

await caption('A pause in typing becomes a git commit');
await Promise.all([saved(ada), saved(bob)]);
await sleep(1500);

await caption('A coding agent pushes with plain git');
git(agentDir, ['pull', '--quiet', '--rebase', 'origin', 'main']);
const file = path.join(agentDir, FILE);
const agentLine = '- build 4812 passed, 212 tests green, image pushed';
writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n${agentLine}\n`);
let shown = await terminalType('git commit -am "Build agent: report build 4812"', '');
git(agentDir, ['commit', '--quiet', '-am', 'Build agent: report build 4812']);
shown = await terminalType('git push origin HEAD:main', shown);
const pushOut = git(agentDir, ['push', 'origin', 'HEAD:main']);
const tPush = Date.now();
await Promise.all([ada, bob].map((p) => p.locator('.cm-content', { hasText: agentLine }).waitFor()));
const agentVisibleMs = Date.now() - tPush;
await set('term', `${shown}${pushOut.split('\n').slice(-2).join('\n')}\n$ `);
await caption('It shows up in both editors, no reload');
// the notice above the editor moved the new line below the fold: each scrolls down a little
const scrollDown = async (page, pause) => {
  await sleep(pause);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 30); await sleep(rand(40, 90)); }
};
await Promise.all([scrollDown(ada, 500), scrollDown(bob, 1300)]);
await sleep(3200);

await caption("Ada opens Forgejo's history: the people who typed, and the agent");
await clickOn(ada, ada.locator('.file-header a', { hasText: 'History' }).first());
await ada.waitForURL(/\/commits\//);
await sleep(1500);
const more = ada.locator('button.ellipsis-button').first();
if (await more.count()) await clickOn(ada, more);
await sleep(4500);

clearInterval(follow);
const videos = await Promise.all([ada, bob, desk].map((p) => p.video().path()));
await Promise.all([ada, bob, desk].map((p) => p.context().close()));
await browser.close();

const history = git(agentDir, ['pull', '--quiet', '--rebase', 'origin', 'main']) || git(agentDir, ['log', '--format=%H %an: %s', '--', FILE]);
writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ file: FILE, agentVisibleMs, timeline, history: history.split('\n') }, null, 2));
log.info(`agent push visible in both editors after ${agentVisibleMs} ms`);

// ---------------------------------------------------------------- one clip out of three

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
const mp4 = path.join(OUT, 'demo.mp4');
const gif = path.join(OUT, 'demo.gif');
ffmpeg(['-ss', '0.8', '-i', videos[2], '-ss', '0.8', '-i', videos[0], '-ss', '0.8', '-i', videos[1],
  '-filter_complex', `[0:v][1:v]overlay=${AT.ada.x}:${AT.ada.y}[a];[a][2:v]overlay=${AT.bob.x}:${AT.bob.y}:shortest=1,fps=25[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', mp4]);
ffmpeg(['-i', mp4, '-filter_complex', 'fps=10,scale=1280:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5', gif]);
log.info(`wrote ${mp4}`);
log.info(`wrote ${gif}`);
