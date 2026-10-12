// Loaded by the git host's own pages (Forgejo: one <script> line in custom/templates/custom/
// footer.tmpl). On the page of a markdown or text file on the served branch it adds an
// "Edit live" button to the file header; pressing it puts the live editor where the rendered
// file was, with the host's header and repository navigation still around it.
//
// The live view has its own URL: the file's URL with ?live=1. The host ignores the parameter and
// renders its file page; this script sees it and mounts the editor. Reload, bookmark and the back
// button therefore all work.
//
// The service fills in CFG when it serves this file: its base path, the editor bundle, and the
// repositories it serves (as hashes of owner/name, so their names are not listed here).
const CFG = /*CONFIG*/{};
const EDITABLE = /\.(md|markdown|mdx|txt)$/i;

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// {owner, repo, file} when this page shows one editable file on a served repository's branch.
async function where() {
  const sub = window.config?.appSubUrl || '';
  const m = /^\/([^/]+)\/([^/]+)\/src\/branch\/(.+)$/.exec(location.pathname.slice(sub.length));
  if (!m || !document.querySelector('.file-view')) return null;
  const owner = decodeURIComponent(m[1]);
  const repo = decodeURIComponent(m[2]);
  const id = await sha256(`${owner}/${repo}`.toLowerCase());
  const served = (CFG.repos || []).find((r) => r.id === id);
  if (!served || !m[3].startsWith(`${served.branch}/`)) return null;
  const file = m[3].slice(served.branch.length + 1).split('/').map(decodeURIComponent).join('/');
  return EDITABLE.test(file) ? { owner, repo, file, sub } : null;
}

const isLive = () => new URLSearchParams(location.search).get('live') === '1';

function liveUrl(on) {
  const u = new URL(location.href);
  if (on) u.searchParams.set('live', '1'); else u.searchParams.delete('live');
  return u.pathname + u.search;
}

let mounted = false;

async function mount(at) {
  if (mounted) return;
  mounted = true;
  const fileView = document.querySelector('.file-view');
  const root = document.createElement('div');
  root.id = 'live-editor';
  root.className = 'lb lb-embed';
  root.dataset.testid = 'live-editor';
  fileView.hidden = true;
  fileView.style.display = 'none';
  fileView.after(root);
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = CFG.css;
  document.head.append(css);
  window.__LB = { base: CFG.base, auth: CFG.auth, forge: at.sub, embed: { owner: at.owner, repo: at.repo, file: at.file, root } };
  try { await import(CFG.entry); } catch (e) {
    root.textContent = `The live editor could not be loaded (${e.message}). Reload the page to try again.`;
  }
}

async function main() {
  const at = await where();
  if (!at) return;
  const actions = document.querySelector('.file-header .file-actions') || document.querySelector('.file-header');
  if (!actions) return;
  const button = document.createElement('a');
  button.id = 'live-edit-button';
  button.dataset.testid = 'edit-live';
  button.className = 'ui mini primary button tw-mr-1';
  const draw = () => {
    button.textContent = isLive() ? 'Close live editor' : 'Edit live';
    button.href = liveUrl(!isLive());
    button.dataset.live = isLive() ? '1' : '0';
  };
  draw();
  button.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    // closing is an ordinary navigation: the host renders the file as it is on the branch by then
    if (isLive()) return;
    e.preventDefault();
    history.pushState(null, '', liveUrl(true));
    draw();
    void mount(at);
  });
  actions.prepend(button);
  // back and forward between the two views: let the host render the page that belongs to the URL
  window.addEventListener('popstate', () => { if (isLive() !== mounted) location.reload(); });
  if (isLive()) await mount(at);
}

main().catch((e) => console.error('live editor:', e));
