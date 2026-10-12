// "Sign in with Forgejo": the real implementation behind the sign-in interface of auth.js.
//
// The browser is sent through Forgejo's OAuth2 provider (authorization code flow). The service
// then knows who the person is (GET /api/v1/user with their token) and keeps their token to
//   - ask Forgejo what they may do with a repository (permissions.push / permissions.pull), and
//   - push their commits as them (hosts/forgejo.js).
// The browser only ever holds a session cookie (HttpOnly, SameSite=Lax); Forgejo tokens stay in
// the service's state directory.
//
// Besides the interface of auth.js (authenticate, describe) this implementation has
//   handle(req, res, seg, url)  the routes /auth/login, /auth/callback, /auth/logout
//   access(user, host)          'write' | 'read' | 'none', asked from Forgejo, cached briefly
//   tokenFor(email)             {login, token} of a signed-in person, refreshed when needed
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCOPE = 'read:user write:repository';
const COOKIE = 'lb_session';
const STATE_COOKIE = 'lb_oauth';

export function parseCookies(headerValue) {
  const out = {};
  for (const part of String(headerValue || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class ForgejoAuth {
  /**
   * @param {object} o
   * @param {string} o.stateDir
   * @param {string} o.baseUrl where the service reaches Forgejo
   * @param {string} o.publicUrl the address people use (Forgejo's ROOT_URL, without the last slash)
   * @param {string} o.basePath the path prefix of the editor on that address, e.g. /live
   * @param {string} o.clientId OAuth2 application of the editor in Forgejo
   * @param {string} o.clientSecret
   * @param {number} [o.accessTtlMs] how long an answer about permissions is reused
   */
  constructor({ stateDir, baseUrl, publicUrl, basePath = '', clientId, clientSecret, accessTtlMs = 10000, sessionDays = 30, logger }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.publicUrl = publicUrl.replace(/\/+$/, '');
    this.basePath = basePath;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessTtlMs = accessTtlMs;
    this.sessionMs = sessionDays * 86400000;
    this.log = logger;
    this.cookieName = COOKIE;
    this.secure = this.publicUrl.startsWith('https:');
    const keyFile = path.join(stateDir, 'forgejo-auth.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.key = readFileSync(keyFile, 'utf8').trim();
    this.file = path.join(stateDir, 'forgejo-sessions.json');
    this.sessions = new Map();
    try { for (const s of JSON.parse(readFileSync(this.file, 'utf8'))) if (Date.now() - s.createdAt < this.sessionMs) this.sessions.set(s.sid, s); } catch { /* first start */ }
    this.accessCache = new Map();
    this.refreshing = new Map();
  }

  get redirectUri() { return `${this.publicUrl}${this.basePath}/auth/callback`; }

  describe() { return { kind: 'forgejo', signIn: `${this.basePath}/auth/login`, note: 'Sign in with your Forgejo account.' }; }

  signIn() { throw Object.assign(new Error('sign in through Forgejo'), { status: 400 }); }

  #save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.sessions.values()]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  #mac(text) { return createHmac('sha256', this.key).update(text).digest('base64url'); }

  #signed(value) { return `${value}.${this.#mac(value)}`; }

  #unsigned(signed) {
    const i = String(signed || '').lastIndexOf('.');
    if (i < 1) return null;
    const value = signed.slice(0, i);
    const want = Buffer.from(this.#mac(value));
    const got = Buffer.from(signed.slice(i + 1));
    return want.length === got.length && timingSafeEqual(want, got) ? value : null;
  }

  #cookie(name, value, maxAgeSec) {
    // only sent to the editor's own paths, not to the git host's pages on the same origin
    return `${name}=${value}; Path=${this.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.secure ? '; Secure' : ''}`;
  }

  /** The person behind a session cookie value, or null. */
  authenticate(token) {
    const sid = this.#unsigned(token);
    const s = sid ? this.sessions.get(sid) : null;
    if (!s || Date.now() - s.createdAt > this.sessionMs) return null;
    return { name: s.name, email: s.email, login: s.login, sid: s.sid };
  }

  // only paths on this site are accepted as the place to come back to
  #next(value) {
    const v = String(value || '');
    return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : `${this.basePath}/`;
  }

  async #token(params) {
    const r = await fetch(`${this.baseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) throw Object.assign(new Error(`Forgejo did not issue a token: ${body.error_description || body.error || `HTTP ${r.status}`}`), { status: 502, refused: r.status >= 400 && r.status < 500 });
    return { accessToken: body.access_token, refreshToken: body.refresh_token || null, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  }

  async #get(route, accessToken) {
    const r = await fetch(`${this.baseUrl}/api/v1${route}`, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }

  /** The routes of the sign-in. Returns false when the request is not one of them. */
  async handle(req, res, seg, url) {
    const redirect = (location, cookies = []) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) }); res.end(); return true; };
    if (req.method === 'GET' && seg[1] === 'login') {
      const state = randomBytes(16).toString('hex');
      const carry = this.#signed(Buffer.from(JSON.stringify({ state, next: this.#next(url.searchParams.get('next')) })).toString('base64url'));
      const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: SCOPE, state });
      return redirect(`${this.publicUrl}/login/oauth/authorize?${q}`, [this.#cookie(STATE_COOKIE, carry, 600)]);
    }
    if (req.method === 'GET' && seg[1] === 'callback') {
      const carried = this.#unsigned(parseCookies(req.headers.cookie)[STATE_COOKIE]);
      let sent = null;
      try { sent = JSON.parse(Buffer.from(carried || '', 'base64url').toString('utf8')); } catch { /* handled below */ }
      const clear = this.#cookie(STATE_COOKIE, '', 0);
      if (url.searchParams.get('error')) throw Object.assign(new Error(`Forgejo did not sign you in: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`), { status: 403, code: 'SIGN_IN_DENIED' });
      if (!sent || !url.searchParams.get('state') || sent.state !== url.searchParams.get('state')) throw Object.assign(new Error('this sign-in was not started in this browser; start again'), { status: 400, code: 'BAD_STATE' });
      const tok = await this.#token({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: this.redirectUri });
      const me = await this.#get('/user', tok.accessToken);
      if (me.status !== 200 || !me.json?.login) throw Object.assign(new Error(`Forgejo did not say who you are (HTTP ${me.status})`), { status: 502 });
      const sid = randomBytes(24).toString('hex');
      this.sessions.set(sid, { sid, login: me.json.login, name: me.json.full_name || me.json.login, email: me.json.email, ...tok, createdAt: Date.now() });
      this.#save();
      this.log?.info(`signed in: ${me.json.login} <${me.json.email}>`);
      return redirect(sent.next, [clear, this.#cookie(COOKIE, this.#signed(sid), Math.floor(this.sessionMs / 1000))]);
    }
    if (seg[1] === 'logout') {
      const sid = this.#unsigned(parseCookies(req.headers.cookie)[COOKIE]);
      if (sid && this.sessions.delete(sid)) this.#save();
      return redirect(`${this.publicUrl}/`, [this.#cookie(COOKIE, '', 0)]);
    }
    return false;
  }

  /** A session's access token, renewed with the refresh token shortly before it runs out. */
  async #fresh(s) {
    if (s.expiresAt - Date.now() > 60000) return s.accessToken;
    if (!s.refreshToken) return s.accessToken;
    let p = this.refreshing.get(s.sid);
    if (!p) {
      p = this.#token({ grant_type: 'refresh_token', refresh_token: s.refreshToken }).then((tok) => {
        Object.assign(s, tok, { refreshToken: tok.refreshToken || s.refreshToken });
        this.#save();
        return s.accessToken;
      }).finally(() => this.refreshing.delete(s.sid));
      this.refreshing.set(s.sid, p);
    }
    return p;
  }

  /** Forgejo credentials of a signed-in person, for pushing their commit as them. */
  async tokenFor(email) {
    const mine = [...this.sessions.values()].filter((s) => s.email === email).sort((a, b) => b.createdAt - a.createdAt);
    for (const s of mine) {
      try { return { login: s.login, token: await this.#fresh(s) }; } catch (e) { this.log?.warn(`${s.login}: token not renewed (${e.message})`); }
    }
    return null;
  }

  /**
   * What Forgejo lets this person do with the repository. Asked with the person's own token, so
   * it is exactly what Forgejo would decide; reused for accessTtlMs. When Forgejo cannot be
   * reached the last answer stands, so an open editor survives a Forgejo restart.
   * @returns {Promise<'write'|'read'|'none'>}
   */
  async access(user, host) {
    const s = this.sessions.get(user.sid);
    if (!s) return 'none';
    const key = `${s.sid}\0${host.slug}`;
    const hit = this.accessCache.get(key);
    if (hit && Date.now() - hit.at < this.accessTtlMs) return hit.level;
    try {
      const r = await this.#get(`/repos/${encodeURIComponent(host.owner)}/${encodeURIComponent(host.repo)}`, await this.#fresh(s));
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const p = r.status === 200 ? r.json?.permissions : null;
      const level = p?.push ? 'write' : p?.pull ? 'read' : 'none';
      this.accessCache.set(key, { level, at: Date.now() });
      return level;
    } catch (e) {
      if (e.refused) { this.accessCache.delete(key); return 'none'; }
      if (hit) { this.log?.warn(`${s.login}: Forgejo not reachable for a permission check (${e.message}); keeping "${hit.level}"`); return hit.level; }
      throw Object.assign(new Error(`Forgejo could not be asked about permissions: ${e.message}`), { status: 503, code: 'HOST_AWAY' });
    }
  }

  async canWrite(user, host) { return (await this.access(user, host)) === 'write'; }
}
