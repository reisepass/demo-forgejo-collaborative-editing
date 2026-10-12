// A repository on a Forgejo instance (Gitea speaks the same API and sends the same webhook).
//
// Reading: git over HTTP from Forgejo with the token of a bot account; when the repository's
// directory is on the same machine, straight from there (a fetch over HTTP costs three requests,
// and Forgejo spends about 70 ms on each just checking the token).
// Writing: an ordinary push over HTTP through Forgejo, never to the repository on disk, so
// Forgejo's own hooks run: permission and branch protection checks, its database, the activity
// feed, webhooks. The push carries the credentials of the person whose text the commit holds
// (their OAuth2 token from "Sign in with Forgejo"), so Forgejo decides with that person's rights
// and shows them as the pusher. Only a commit nobody typed (or whose author has no usable
// sign-in any more) is pushed by the bot.
//
// Moves of main: a repository webhook (event "push", signed) that the adapter creates itself when
// the bot may administer the repository; the bridge's polling always runs as well.
//
// Hooks (optional, need the repository's directory on the same machine), both plain files in the
// repository's hooks/<name>.d/, which Forgejo runs after its own hook of that name:
//   post-receive  pokes the service the moment a push has landed. The webhook says the same, but
//                 Forgejo delivers it through two queues that are polled (see the README).
//   pre-receive   demand flush: asks the service before somebody else's push to main lands, see
//                 Bridge.preflush.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GitHost } from './base.js';

const MARK = '# live-bridge hook';
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const basic = (user, secret) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
// Credentials travel in git's environment, never on a command line. The empty credential.helper
// clears the list of helpers, so git never asks (or tells) a keychain or a credential cache.
const header = (value) => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: ${value}` });

export class ForgejoHost extends GitHost {
  /**
   * @param {object} o
   * @param {string} o.baseUrl where the service reaches Forgejo (not the public address)
   * @param {string} o.owner
   * @param {string} o.repo
   * @param {string} o.botUser account the service reads with
   * @param {string} o.botToken its access token (write:repository)
   * @param {string} [o.webhookSecret] shared secret of the webhook; empty: polling only
   * @param {string} [o.webhookUrl] where Forgejo reaches this service's webhook endpoint
   * @param {(email: string) => Promise<{login: string, token: string}|null>} [o.tokenFor] the
   *   signed-in person's Forgejo credentials (see auth-forgejo.js)
   * @param {string} [o.repoDir] the bare repository on this machine: turns on the hooks
   * @param {boolean} [o.diskRead] with repoDir: read (fetch) from that directory (default true)
   * @param {boolean} [o.pokeHook] install the post-receive poke (default true)
   * @param {boolean} [o.demandFlush] install the pre-receive demand flush (default true)
   */
  constructor({ baseUrl, owner, repo, botUser, botToken, webhookSecret = '', webhookUrl = '', tokenFor = null, repoDir = '', diskRead = true, pokeHook = true, demandFlush = true }) {
    const base = baseUrl.replace(/\/+$/, '');
    super({ kind: 'forgejo', owner, repo, url: `${base}/${owner}/${repo}.git` });
    this.baseUrl = base;
    this.botUser = botUser;
    this.botToken = botToken;
    this.webhookSecret = webhookSecret;
    this.webhookUrl = webhookUrl;
    this.tokenFor = tokenFor;
    this.repoDir = repoDir ? path.resolve(repoDir) : '';
    this.diskRead = diskRead;
    this.pokeHook = pokeHook;
    this.demandFlush = demandFlush;
    this.onMove = null;
    this.branch = 'main';
    this.pushedAs = { person: 0, bot: 0 };
  }

  gitEnv() { return header(basic(this.botUser, this.botToken)); }

  fetch(git, branch) { return git.fetch(branch, this.repoDir && this.diskRead ? { from: this.repoDir } : {}); }

  async push(git, commit, ref, { author } = {}) {
    let who = null;
    if (author && this.tokenFor) who = await this.tokenFor(author.email).catch(() => null);
    this.pushedAs[who ? 'person' : 'bot'] += 1;
    const res = await git.push(commit, ref, who ? { env: header(basic(who.login, who.token)) } : {});
    res.pushedAs = who ? who.login : this.botUser;
    return res;
  }

  /** One call to Forgejo's API with the bot's token. */
  async api(method, route, body) {
    const r = await fetch(`${this.baseUrl}/api/v1${route}`, {
      method,
      headers: { accept: 'application/json', authorization: `token ${this.botToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, json, text };
  }

  async watch({ onMove, branch = 'main', stateDir, pokeUrl, preflushUrl, log }) {
    this.onMove = onMove;
    this.branch = branch;
    const how = [];
    if (this.webhookSecret && this.webhookUrl) {
      try { how.push(await this.#ensureWebhook()); } catch (e) { log?.warn(`${this.slug}: no webhook (${e.message}); relying on polling`); }
    }
    if (this.repoDir) {
      // the addresses are read from files at push time, so a restart on another port needs no new hooks
      writeFileSync(path.join(stateDir, 'poke-url'), `${pokeUrl}\n`, { mode: 0o600 });
      writeFileSync(path.join(stateDir, 'preflush-url'), `${preflushUrl}\n`, { mode: 0o600 });
      for (const [kind, on, body] of [['post-receive', this.pokeHook, this.#pokeScript(stateDir)], ['pre-receive', this.demandFlush, this.#preflushScript(stateDir)]]) {
        try { const done = this.#installHook(kind, on, body); if (done) how.push(done); } catch (e) { log?.warn(`${this.slug}: no ${kind} hook (${e.message})`); }
      }
    }
    return how;
  }

  async unwatch() { this.onMove = null; }

  // The webhook is found again by its URL; its secret is set on every start, so a new secret in
  // the service's configuration needs nothing done in Forgejo.
  async #ensureWebhook() {
    const route = `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/hooks`;
    const list = await this.api('GET', route);
    if (list.status !== 200) throw new Error(`listing webhooks: HTTP ${list.status} (the bot needs admin permission on the repository)`);
    const config = { url: this.webhookUrl, content_type: 'json', secret: this.webhookSecret };
    const mine = list.json.find((h) => h.config?.url === this.webhookUrl);
    const r = mine
      ? await this.api('PATCH', `${route}/${mine.id}`, { config, events: ['push'], active: true })
      : await this.api('POST', route, { type: 'forgejo', config, events: ['push'], active: true });
    if (r.status !== 200 && r.status !== 201) throw new Error(`${mine ? 'updating' : 'creating'} the webhook: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    return `webhook ${r.json.id}`;
  }

  // Forgejo runs every executable in <repository>/hooks/<kind>.d/ after its own hook of that kind
  // (for pre-receive: after it has checked permission and branch protection). A hook that is
  // switched off again is replaced by one that does nothing.
  #installHook(kind, on, body) {
    if (!existsSync(path.join(this.repoDir, 'HEAD'))) throw new Error(`${this.repoDir} is not a bare repository`);
    const dir = path.join(this.repoDir, 'hooks', `${kind}.d`);
    const file = path.join(dir, 'live-bridge');
    const mine = existsSync(file) && readFileSync(file, 'utf8').includes(MARK);
    if (existsSync(file) && !mine) throw new Error(`${file} exists and is not a bridge hook`);
    if (!on && !mine) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, on ? body : `#!/bin/sh\n${MARK} (${kind}), switched off. Delete this file to remove it.\nexit 0\n`, { mode: 0o755 });
    chmodSync(file, 0o755);
    return on ? `${kind} hook` : null;
  }

  #pokeScript(stateDir) {
    return `#!/bin/sh
${MARK} (post-receive, poke). Delete this file to remove it.
# Tells the live editor service that ${this.branch} moved, so open editors show the push at once.
url=$(cat ${q(path.join(stateDir, 'poke-url'))} 2>/dev/null) || exit 0
commit=
while read old new ref; do [ "$ref" = ${q(`refs/heads/${this.branch}`)} ] && commit=$new; done
[ -n "$commit" ] || exit 0
curl -fsS -m 1 -X POST "$url&commit=$commit" >/dev/null 2>&1
exit 0
`;
  }

  // Only exit code 1 after the service's "409" rejects; a service that is down, slow or confused
  // lets the push through.
  #preflushScript(stateDir) {
    return `#!/bin/sh
${MARK} (pre-receive, demand flush). Delete this file to remove it.
# Before a push to ${this.branch} lands, the live editor service commits text people have typed
# into the files this push touches; the push is then turned away once so the pusher rebases.
url=$(cat ${q(path.join(stateDir, 'preflush-url'))} 2>/dev/null) || exit 0
zero=0000000000000000000000000000000000000000
while read old new ref; do
  [ "$ref" = ${q(`refs/heads/${this.branch}`)} ] || continue
  [ "$old" = "$zero" ] && continue
  [ "$new" = "$zero" ] && continue
  paths=$(git diff --name-only "$old" "$new" 2>/dev/null) || exit 0
  first=$(git log --no-merges --reverse --format='%ae %at %s' "$old..$new" 2>/dev/null | head -n 1)
  answer=$(printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "$old" "$new" "\${GITEA_PUSHER_NAME:-}" "$first" "$paths" | curl -sS -m 8 -X POST --data-binary @- -w '\\n%{http_code}' "$url" 2>/dev/null) || exit 0
  code=$(printf '%s' "$answer" | tail -n 1)
  if [ "$code" = "409" ]; then
    printf '%s\\n' "$answer" | sed '$d' | sed 's/^/bridge: /' >&2
    exit 1
  fi
done
exit 0
`;
  }

  /**
   * True when `signature` is the HMAC-SHA256 of the raw body. Forgejo sends it as plain hex in
   * X-Forgejo-Signature (and X-Gitea-Signature), and GitHub style ("sha256=" in front) in
   * X-Hub-Signature-256; either form is accepted.
   */
  verify(rawBody, signature) {
    if (!this.webhookSecret || typeof signature !== 'string' || !signature) return false;
    const want = Buffer.from(createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex'));
    const got = Buffer.from(signature.replace(/^sha256=/, '').toLowerCase());
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /**
   * A verified webhook delivery. Returns what was done with it.
   * @param {string} event the X-Forgejo-Event header
   * @param {object} payload
   */
  webhook(event, payload) {
    if (event !== 'push') return { ok: true, action: 'ignored', why: `event ${event}` };
    if (payload?.ref !== `refs/heads/${this.branch}`) return { ok: true, action: 'ignored', why: `ref ${payload?.ref}` };
    if (/^0+$/.test(payload.after || '')) return { ok: true, action: 'ignored', why: 'branch deleted' };
    this.onMove?.('webhook', payload.after);
    return { ok: true, action: 'poked', after: payload.after };
  }
}
