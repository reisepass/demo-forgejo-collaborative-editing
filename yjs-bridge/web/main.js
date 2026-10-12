// The editor: plain markdown text in CodeMirror, bound to the room's Y.Text. Nothing in here
// formats or rewrites the text; what is not typed stays as it is in git.
//
// Views, each with its own URL (all below the service's base path, if it has one):
//   /signin                      development sign-in (name and email)
//   /                            the repositories of this service
//   /r/<owner>/<repo>            file tree of main
//   /r/<owner>/<repo>/edit/<path> the live editor
// Mounted by web/embed.js inside a git host's own file page, only the editor is drawn, into the
// element that script hands over; the URL is then the host's.
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import { LiveClient } from '../src/client/live.js';
import './style.css';

const marks = { nav: performance.now() };
window.__lb = { marks };

// Set by the service in the page (or by embed.js): base path, kind of sign-in, the git host's
// pages on this origin, and the file to edit when mounted inside one of them.
const CFG = window.__LB || {};
const BASE = CFG.base || '';
const COOKIE = CFG.auth === 'forgejo';
const EMBED = CFG.embed || null;
const FORGE = typeof CFG.forge === 'string' ? CFG.forge : null;

// ---------------------------------------------------------------- session
// Development sign-in: a token in localStorage. Sign-in with the git host: a cookie the page
// cannot read; who is signed in is asked from the service.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const token = () => (COOKIE ? null : store.get('lb.token'));
let session = null;
const me = () => { if (COOKIE) return session; try { return JSON.parse(store.get('lb.user') || 'null'); } catch { return null; } };

// Off to the git host's sign-in; it sends the browser back to the page it is on now.
function toSignIn() {
  location.assign(`${BASE}/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  return new Promise(() => {});
}

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? {} : { Authorization: `Bearer ${token()}` }) } });
  if (r.status === 401) { if (COOKIE) await toSignIn(); signOut(); throw new Error('sign in first'); }
  return r;
}

function signOut() {
  store.del('lb.token');
  store.del('lb.user');
}

// ---------------------------------------------------------------- dom helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const mono = (text, testid) => h('span', { class: 'mono', ...(testid ? { 'data-testid': testid } : {}) }, text);
const app = EMBED ? EMBED.root : document.getElementById('app');

// ---------------------------------------------------------------- routing

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const repoUrl = (o, r) => `${BASE}/r/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;
// pages of the git host on this origin (null when there is none)
const forge = (o, r, ...rest) => (FORGE === null ? null : `${FORGE}/${encodeURIComponent(o)}/${encodeURIComponent(r)}${rest.length ? `/${rest.join('/')}` : ''}`);
const editUrl = (o, r, file) => `${repoUrl(o, r)}/edit/${enc(file)}`;

let leave = null;

async function navigate(url, replace = false) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  await render();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  void navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', () => void render());

function link(href, text, testid) {
  return h('a', { href, 'data-link': '', ...(testid ? { 'data-testid': testid } : {}) }, text);
}

async function render() {
  if (leave) { const fn = leave; leave = null; fn(); }
  const url = new URL(location.href);
  const parts = url.pathname.slice(BASE.length).split('/').filter(Boolean).map(decodeURIComponent);
  app.replaceChildren();
  if (COOKIE) {
    if (!session) {
      const r = await fetch(`${BASE}/api/me`);
      if (r.status === 401) return toSignIn();
      session = (await r.json()).user;
    }
  } else if (!token() || !me()) {
    if (parts[0] !== 'signin') history.replaceState(null, '', `${BASE}/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
    return renderSignIn();
  }
  if (EMBED) {
    try { return await renderEditor(EMBED.owner, EMBED.repo, EMBED.file); } catch (e) {
      app.append(h('p', { class: 'banner error', 'data-testid': 'page-error' }, e.message));
      return undefined;
    }
  }
  if (parts[0] === 'signin') return navigate(new URL(location.href).searchParams.get('next') || `${BASE}/`, true);
  const user = me();
  const out = h('button', { 'data-testid': 'sign-out' }, 'Sign out');
  out.onclick = () => { if (COOKIE) { location.assign(`${BASE}/auth/logout`); return; } signOut(); void navigate(`${BASE}/signin`); };
  app.append(h('header', { class: 'top' }, h('h1', {}, link(`${BASE}/`, 'Live markdown editor')), h('span', { class: 'who' }, h('span', { 'data-testid': 'whoami' }, `${user.name} <${user.email}>`), ' ', out)));
  try {
    if (parts[0] === 'r' && parts.length === 3) return await renderTree(parts[1], parts[2]);
    if (parts[0] === 'r' && parts[3] === 'edit' && parts.length > 4) return await renderEditor(parts[1], parts[2], parts.slice(4).join('/'));
    if (parts.length === 0) return await renderRepos();
    app.append(h('p', { class: 'banner error', 'data-testid': 'not-found' }, `No such page: ${url.pathname}`));
  } catch (e) {
    if (!COOKIE && !token()) return navigate(`${BASE}/signin?next=${encodeURIComponent(url.pathname)}`, true);
    app.append(h('p', { class: 'banner error', 'data-testid': 'page-error' }, e.message));
  }
  return undefined;
}

// ---------------------------------------------------------------- sign in

async function renderSignIn() {
  const info = await fetch(`${BASE}/api/auth`).then((r) => r.json()).catch(() => ({}));
  const name = h('input', { name: 'name', placeholder: 'Your name', required: '', autocomplete: 'name', 'data-testid': 'signin-name' });
  const email = h('input', { name: 'email', type: 'email', placeholder: 'you@example.org', required: '', autocomplete: 'email', 'data-testid': 'signin-email' });
  const err = h('p', { class: 'banner error', hidden: '', 'data-testid': 'signin-error' });
  const form = h('form', { class: 'stack' }, h('label', {}, 'Name ', name), h('label', {}, 'Email ', email), h('button', { type: 'submit', 'data-testid': 'signin-submit' }, 'Sign in'), err);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch(`${BASE}/api/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value, email: email.value }) });
    const body = await r.json();
    if (!r.ok) { err.hidden = false; err.textContent = body.error; return; }
    store.set('lb.token', body.token);
    store.set('lb.user', JSON.stringify(body.user));
    void navigate(new URL(location.href).searchParams.get('next') || `${BASE}/`, true);
  };
  app.append(h('header', { class: 'top' }, h('h1', {}, 'Live markdown editor')), h('h2', {}, 'Sign in'),
    h('p', { class: 'hint', 'data-testid': 'signin-note' }, info.note || '', ' Your commits are authored with this name and email address.'), form);
}

// ---------------------------------------------------------------- repositories and files

async function renderRepos() {
  const { repos } = await (await api('/api/me')).json();
  if (repos.length === 1) return navigate(repoUrl(repos[0].owner, repos[0].repo), true);
  app.append(h('h2', {}, 'Repositories'), h('ul', { class: 'files' }, ...repos.map((r) => h('li', {}, link(repoUrl(r.owner, r.repo), `${r.owner}/${r.repo}`, 'repo-link')))));
  return undefined;
}

const EDITABLE = /\.(md|markdown|mdx|txt)$/i;

async function renderTree(owner, repo) {
  document.title = `${owner}/${repo}`;
  const r = await api(`/api/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  app.append(
    h('p', { class: 'crumbs' }, h('strong', { 'data-testid': 'repo-name' }, `${owner}/${repo}`), ' at ', mono(body.tip || 'no commit yet', 'tree-tip')),
    h('ul', { class: 'files', 'data-testid': 'file-list' }, ...body.files.map((f) => (EDITABLE.test(f)
      ? h('li', {}, link(editUrl(owner, repo, f), f, 'file-link'))
      : h('li', { class: 'other', title: 'not a markdown or text file' }, f)))),
  );
}

// ---------------------------------------------------------------- the editor

const COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];
function colorOf(email) {
  let n = 0;
  for (const ch of email) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[n % COLORS.length];
}

const END_REASONS = { idle: 'nobody typed for a while', 'closed-by-request': 'it was closed on request', 'no-participants': 'everyone had left', 'nobody-joined': 'nobody had joined' };

async function loadState(owner, repo, file) {
  const key = `${owner}/${repo}/${file}`;
  const pre = window.__pre;
  window.__pre = null;
  let res;
  if (pre && pre.key === key) res = await pre.p;
  else {
    const r = await api(`/api/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/state?path=${encodeURIComponent(file)}`);
    res = { status: r.status, room: r.headers.get('x-room'), body: await r.arrayBuffer() };
  }
  if (res.status === 401) { if (COOKIE) await toSignIn(); signOut(); throw new Error('sign in first'); }
  if (res.status !== 200) {
    let msg = `could not open ${file} (HTTP ${res.status})`;
    try { msg = JSON.parse(new TextDecoder().decode(res.body)).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const b64 = res.room.replace(/-/g, '+').replace(/_/g, '/');
  const room = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  return { room, update: new Uint8Array(res.body) };
}

async function renderEditor(owner, repo, file) {
  document.title = `${file} - ${owner}/${repo}`;
  const user = me();
  const state = h('div', { class: 'save-state', 'data-testid': 'save-state', 'data-phase': 'loading' }, 'Loading');
  const people = h('div', { class: 'people', 'data-testid': 'people' });
  const banners = h('div', { 'data-testid': 'banners' });
  const editorEl = h('div', { class: 'editor', 'data-testid': 'editor' });
  const previewEl = h('div', { class: 'preview', 'data-testid': 'preview' });
  const hostPage = forge(owner, repo, 'src', 'branch', 'main', enc(file));
  // inside the git host's file page its own header already says which file this is
  if (!EMBED) {
    app.append(h('p', { class: 'crumbs' }, link(repoUrl(owner, repo), `${owner}/${repo}`, 'back-to-repo'), ' / ', h('strong', { 'data-testid': 'file-path' }, file),
      hostPage ? h('span', {}, ' (', h('a', { href: hostPage, 'data-testid': 'host-page' }, 'the file in the repository'), ')') : null));
  }
  app.append(state, people, banners, h('div', { class: 'split' }, editorEl, previewEl));
  // a commit or a branch, linked to its page on the git host when there is one
  const commitRef = (hash, testid) => {
    const url = hash && forge(owner, repo, 'commit', hash);
    return url ? h('a', { href: url, class: 'mono', 'data-testid': testid }, hash) : mono(hash, testid);
  };
  const branchRef = (name, testid) => {
    const url = forge(owner, repo, 'src', 'branch', enc(name));
    return url ? h('a', { href: url, class: 'mono', 'data-testid': testid }, name) : mono(name, testid);
  };

  let { room, update } = await loadState(owner, repo, file);
  marks.stateFetched = performance.now();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update, 'http');
  const ytext = doc.getText('text');
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', { name: user.name, email: user.email, color: colorOf(user.email), colorLight: `${colorOf(user.email)}33` });

  let status = { connected: false, synced: false, pending: false };
  let removed = null;
  let gone = false;
  let flushProblem = null;
  // someone who may read the repository but not push watches: the editor takes no input
  const writable = new Compartment();
  const lock = (readOnly) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

  const view = new EditorView({
    doc: ytext.toString(),
    parent: editorEl,
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(ytext, awareness),
      writable.of(lock(room.access === 'read')),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (!marks.firstInput && u.transactions.some((tr) => tr.isUserEvent('input'))) marks.firstInput = performance.now();
        schedulePreview();
      }),
    ],
  });
  view.focus();
  marks.editorReady = performance.now();
  marks.wsOpenAtPaint = false;
  requestAnimationFrame(() => { marks.textPainted = performance.now(); marks.wsOpenAtPaint = status.connected; });

  // ---- preview: loaded after the text is on screen, and only on request for a large document
  let previewTimer = null;
  let renderPreview = null;
  let previewOn = ytext.length <= 200000;
  function drawPreview() {
    if (!previewOn || !renderPreview || gone) return;
    previewEl.innerHTML = renderPreview(ytext.toString());
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(drawPreview, 200);
  }
  function startPreview() {
    previewOn = true;
    previewEl.textContent = '';
    import('./preview.js').then((m) => { renderPreview = m.renderPreview; drawPreview(); });
  }
  if (previewOn) setTimeout(startPreview, 0);
  else {
    const b = h('button', { 'data-testid': 'show-preview' }, 'Show preview');
    b.onclick = startPreview;
    previewEl.append(h('p', { class: 'hint' }, 'This is a large file; the preview is off until asked for. '), b);
  }

  // ---- status line
  function drawStatus() {
    let phase;
    let text;
    if (removed) { phase = 'error'; text = 'This file is no longer on main. Nothing typed here is saved any more.'; }
    else if (!status.connected) { phase = 'offline'; text = `Not connected to the service, trying again. ${status.pending ? 'What you typed stays in this tab and is sent when the connection is back.' : 'Keep typing: it is sent when the connection is back.'}`; }
    else if (room.session === 'ended') { phase = 'ended'; text = `Live session ended. main is at the text of ${room.base}`; }
    else if (status.pending || room.dirty) { phase = 'unsaved'; text = `Typing not on main yet. It is committed after a pause of ${room.debounceMs / 1000} s (at the latest after ${room.maxWaitMs / 1000} s).${room.held ? ' A change from main to a line you are typing on waits until you pause.' : ''}`; }
    else { phase = 'saved'; text = `Everything typed is on main. This text is main at ${room.base}`; }
    if (phase === 'saved') { flushProblem = null; banners.querySelector('[data-testid="flush-failed"]')?.remove(); }
    state.dataset.phase = phase;
    state.dataset.base = room.base || '';
    state.dataset.session = String(room.seq || '');
    state.dataset.access = room.access || 'write';
    state.textContent = text;
  }

  function drawAccess() {
    const readOnly = room.access === 'read';
    view.dispatch({ effects: writable.reconfigure(lock(readOnly)) });
    banners.querySelector('[data-testid="read-only"]')?.remove();
    if (readOnly) banners.prepend(h('div', { class: 'banner readonly', 'data-testid': 'read-only', role: 'status' }, 'You can read this repository but not push to it, so this is view only: you see what the others type as they type it. Ask for push permission on the repository to edit.'));
  }

  function drawPeople() {
    people.replaceChildren(h('span', {}, 'In this file: '));
    const seen = new Map();
    for (const [id, s] of awareness.getStates()) {
      if (!s.user) continue;
      const known = seen.get(s.user.email);
      seen.set(s.user.email, { ...s.user, you: id === doc.clientID || (known && known.you) });
    }
    // the same order in every browser
    for (const p of [...seen.values()].sort((x, y) => x.name.localeCompare(y.name) || x.email.localeCompare(y.email))) {
      people.append(h('span', { class: 'person', 'data-testid': 'person', style: `--c: ${p.color}`, title: p.email }, p.name + (p.you ? ' (you)' : '')));
    }
  }
  awareness.on('change', drawPeople);
  drawPeople();

  // ---- banners
  function banner(cls, testid, key, ...children) {
    if (key) banners.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
    const b = h('div', { class: `banner ${cls}`, 'data-testid': testid, role: 'status', ...(key ? { 'data-key': key } : {}) }, ...children);
    const x = h('button', { 'data-testid': 'dismiss' }, 'Dismiss');
    x.onclick = () => { b.remove(); if (key) store.set(`lb.dismissed.${key}`, '1'); };
    b.append(h('div', {}, x));
    banners.prepend(b);
    return b;
  }

  function showFold(n) {
    const more = (n.commits || []).filter((c) => c !== n.commit);
    banner('notice', 'fold-notice', null,
      'Changed by ', h('strong', { 'data-testid': 'fold-author' }, n.author.name || 'unknown'), ' in ', commitRef(n.commit, 'fold-commit'),
      more.length ? h('span', {}, ` (and ${more.length} earlier commit${more.length > 1 ? 's' : ''}: `, mono(more.join(', ')), ')') : null,
      n.changed ? '. The text below was updated.' : '.');
    const all = banners.querySelectorAll('[data-testid="fold-notice"]');
    for (let i = 3; i < all.length; i++) all[i].remove();
  }

  function showConflict(c) {
    if (store.get(`lb.dismissed.${c.branch}`)) return;
    const mine = c.email === user.email;
    banner('conflict', 'conflict-banner', c.branch,
      c.why === 'file removed on main'
        ? h('span', {}, 'The file was removed on main in ', commitRef(c.mainCommit, 'conflict-main-commit'), '. ')
        : h('span', {}, h('strong', { 'data-testid': 'conflict-author' }, c.mainAuthor || 'Someone'), ` changed line${c.lines && c.lines.length > 1 ? 's' : ''} ${(c.lines || []).join(', ')} on main in `, commitRef(c.mainCommit, 'conflict-main-commit'), ` while ${mine ? 'you were' : `${c.user} was`} changing the same. main keeps its version and the editor now shows it. `),
      `${mine ? 'Your' : `${c.user}'s`} complete text from before the merge is kept on branch `, branchRef(c.branch, 'conflict-branch'), ' (commit ', commitRef(c.commit, 'conflict-commit'), c.pushed ? ').' : '), which is not pushed yet.');
  }

  function drawSession(prev) {
    banners.querySelector('[data-testid="session-ended"]')?.remove();
    if (room.session === 'ended') {
      const resume = h('button', { 'data-testid': 'resume' }, 'Resume');
      resume.onclick = () => client.tell({ type: 'resume' });
      const b = h('div', { class: 'banner ended', 'data-testid': 'session-ended', role: 'status' },
        `This live session has ended (${END_REASONS[room.endReason] || room.endReason || 'ended'}). Everything typed is on main at `, mono(room.base, 'ended-base'),
        '. This page no longer follows main. Type, or press Resume, and a new session starts with what is on main by then.', h('div', {}, resume));
      banners.prepend(b);
    } else if (prev === 'ended') {
      banner('notice', 'session-started', 'session-started', `A new live session started (number ${room.seq}).`);
    }
  }

  // ---- connection
  const wsUrl = () => `${location.origin.replace(/^http/, 'ws')}${BASE}/ws?repo=${encodeURIComponent(`${owner}/${repo}`)}&path=${encodeURIComponent(file)}&docId=${room.docId}${COOKIE ? '' : `&token=${encodeURIComponent(token())}`}`;
  const client = new LiveClient({
    url: wsUrl,
    doc,
    awareness,
    onStatus: (s) => {
      if (s.connected && !marks.wsOpen) marks.wsOpen = performance.now();
      if (s.synced && !marks.synced) marks.synced = performance.now();
      status = s;
      drawStatus();
    },
    onControl: (msg) => {
      if (msg.type === 'hello' || msg.type === 'state') {
        const prev = room.session;
        const access = room.access;
        room = { ...room, ...msg };
        if (room.access !== access) drawAccess();
        if (msg.type === 'hello') for (const c of msg.conflicts || []) if (Date.now() - new Date(c.at).getTime() < 86400000) showConflict(c);
        if (prev !== room.session || msg.type === 'hello') drawSession(prev);
        drawStatus();
      } else if (msg.type === 'notice' && msg.kind === 'fold') showFold(msg);
      else if (msg.type === 'notice' && msg.kind === 'flush-failed') {
        // shown from the second failure on: one rejected push while main moves is ordinary
        if (msg.failures >= 2 && flushProblem !== msg.message) {
          flushProblem = msg.message;
          banners.querySelector('[data-testid="flush-failed"]')?.remove();
          banners.prepend(h('div', { class: 'banner error', 'data-testid': 'flush-failed', role: 'status' }, 'What was typed could not be put on main yet and is kept here; the service keeps trying. Reason: ', h('span', { class: 'mono' }, msg.message)));
        }
      }
      else if (msg.type === 'conflict') showConflict(msg);
      else if (msg.type === 'removed') {
        removed = msg;
        banner('error', 'file-removed', null, 'This file was removed on main by ', h('strong', {}, msg.author?.name || 'someone'), ' in ', mono(msg.commit, 'removed-commit'), msg.branch ? h('span', {}, '. What was typed and not yet committed is on branch ', mono(msg.branch, 'conflict-branch'), '.') : '.');
        drawStatus();
      } else if (msg.type === 'reset') void startOver();
    },
    onRefused: (code, reason) => {
      banner('error', 'refused', 'refused', `The service refused the connection (${reason || code}). Reload the page to try again.`);
      return false;
    },
  });
  window.__lb.client = client;
  window.__lb.view = view;
  window.__lb.text = () => ytext.toString();
  client.connect();
  drawStatus();
  if (room.access === 'read') drawAccess();

  // The service no longer has the document this tab holds (the file was removed and came back,
  // or the service lost its state). Text typed here and not confirmed is kept on a branch, then
  // the page starts again from the current document.
  let restarting = false;
  async function startOver() {
    if (restarting || gone) return;
    restarting = true;
    let saved = null;
    if (client.pending()) {
      try {
        const r = await api(`/api/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/orphan?path=${encodeURIComponent(file)}`, { method: 'POST', body: ytext.toString() });
        saved = await r.json();
      } catch { /* shown below */ }
      if (!saved || !saved.ok) { banner('error', 'orphan-failed', null, 'The service has a new document for this file and the text typed in this tab could not be saved. It is still in the editor below: copy it before leaving this page.'); return; }
    }
    await render();
    if (saved && saved.branch) {
      const b = h('div', { class: 'banner conflict', 'data-testid': 'orphan-banner', role: 'status' }, 'The service had a new document for this file. What was typed in this tab and not yet confirmed is kept on branch ', mono(saved.branch, 'conflict-branch'), ' (commit ', mono(saved.commit, 'conflict-commit'), ').');
      document.querySelector('[data-testid="banners"]')?.prepend(b);
    }
  }

  leave = () => {
    gone = true;
    clearTimeout(previewTimer);
    client.close();
    view.destroy();
    awareness.destroy();
    doc.destroy();
  };
}

void render();
