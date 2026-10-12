// The one service: serves the editor, hosts the rooms over a websocket, takes the pokes that say
// main moved (local hook, GitHub or Forgejo webhook) and runs one bridge per repository.
//
// With a base path (for example /live) every route lives under it, so a reverse proxy can put
// the service on the same origin as the git host without rewriting anything.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { makeLogger } from './logger.js';
import { parseCookies } from './auth-forgejo.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml' };

function readBody(req, limit = 26 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export class Service {
  /**
   * @param {object} o
   * @param {import('./bridge.js').Bridge[]} o.bridges
   * @param {object} o.auth see auth.js
   * @param {string} o.webDir the built editor (web/build.js)
   * @param {number} [o.port] 0 picks a free one
   * @param {string} [o.host]
   * @param {string} [o.basePath] path prefix of every route, e.g. /live
   * @param {string} [o.publicUrl] the origin people use; with cookie sign-in, requests that change
   *   something and websockets from any other origin are refused
   * @param {string} [o.forgeUrl] path of the git host's pages on the same origin ('' = its root);
   *   the editor then links commits, branches and files to it
   */
  constructor({ bridges, auth, webDir, port = 0, host = '127.0.0.1', logger, basePath = '', publicUrl = '', forgeUrl = null }) {
    this.basePath = basePath.replace(/\/+$/, '');
    this.publicOrigin = publicUrl ? new URL(publicUrl).origin : '';
    this.forgeUrl = forgeUrl;
    this.bridges = new Map(bridges.map((b) => [b.slug.toLowerCase(), b]));
    this.auth = auth;
    this.webDir = webDir;
    this.port = port;
    this.host = host;
    this.log = logger || makeLogger('http');
    this.pokeToken = randomBytes(16).toString('hex');
    this.assets = new Map();
    this.sockets = new Set();
  }

  async start() {
    this.http = http.createServer((req, res) => {
      this.#route(req, res).catch((e) => {
        const status = e.status || 500;
        if (status >= 500) this.log.error(`${req.method} ${req.url}: ${e.stack || e.message}`);
        if (!res.headersSent) this.#json(res, status, { error: e.message, code: e.code || 'ERROR' });
        else res.end();
      });
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    this.http.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    await new Promise((resolve, reject) => { this.http.once('error', reject); this.http.listen(this.port, this.host, resolve); });
    this.port = this.http.address().port;
    this.origin = `http://${this.host === '0.0.0.0' ? '127.0.0.1' : this.host}:${this.port}`;
    for (const b of this.bridges.values()) {
      const how = await b.host.watch({
        stateDir: b.stateDir,
        branch: b.branch,
        log: this.log,
        pokeUrl: `${this.origin}${this.basePath}/internal/poke/${this.pokeToken}?repo=${encodeURIComponent(b.slug)}`,
        preflushUrl: `${this.origin}${this.basePath}/internal/preflush/${this.pokeToken}?repo=${encodeURIComponent(b.slug)}`,
        // the host also announces the bridge's own pushes; those are known already
        onMove: (reason, commit) => { if (!commit || !b.ownPushes.includes(commit)) b.poke(reason); },
      });
      await b.start();
      this.log.info(`${b.slug}: main is watched by polling every ${b.pollMs} ms${how.length ? ` and ${how.join(', ')}` : ''}`);
    }
    this.log.info(`editor at ${this.origin}${this.basePath}/`);
  }

  async stop() {
    for (const ws of this.sockets) ws.close(1001, 'service stopping');
    for (const b of this.bridges.values()) { await b.stop(); await b.host.unwatch(); }
    const closed = new Promise((resolve) => this.http.close(resolve));
    // The rooms are flushed and the editors were told. What is left may include a connection a
    // browser opened and never used; close() alone would wait for it until Node's header timeout.
    this.http.closeAllConnections();
    await closed;
  }

  #json(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  }

  #user(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    if (token || !this.auth.cookieName) return this.auth.authenticate(token);
    // A cookie travels with requests other sites make the browser send. Those that change
    // something, and websockets, must come from this site's own pages.
    const acts = req.headers.upgrade || (req.method !== 'GET' && req.method !== 'HEAD');
    if (acts && this.publicOrigin && req.headers.origin !== this.publicOrigin) return null;
    return this.auth.authenticate(parseCookies(req.headers.cookie)[this.auth.cookieName]);
  }

  /** 'write', 'read' or 'none': what the sign-in implementation says this person may do with the repository. */
  async #access(user, bridge) {
    if (this.auth.access) return this.auth.access(user, bridge.host);
    return await this.auth.canWrite(user, bridge.host) ? 'write' : 'none';
  }

  #need(req, url) {
    const user = this.#user(req, url);
    if (!user) throw Object.assign(new Error('sign in first'), { status: 401, code: 'SIGN_IN' });
    return user;
  }

  #bridge(owner, repo) {
    const b = this.bridges.get(`${owner}/${repo}`.toLowerCase());
    if (!b) throw Object.assign(new Error(`no repository ${owner}/${repo} on this service`), { status: 404, code: 'NO_REPO' });
    return b;
  }

  #static(req, res, rel) {
    let a = this.assets.get(rel);
    const file = path.join(this.webDir, rel);
    if (!a) {
      if (!file.startsWith(this.webDir + path.sep) || !existsSync(file) || !statSync(file).isFile()) return false;
      let buf = readFileSync(file);
      if (rel === 'index.html') buf = this.#page(buf);
      a = { buf, gz: gzipSync(buf), etag: `"${createHash('sha256').update(buf).digest('hex').slice(0, 32)}"`, type: TYPES[path.extname(rel)] || 'application/octet-stream' };
      this.assets.set(rel, a);
    }
    // hashed file names (chunks) never change; the entry points are revalidated
    const cache = /-[A-Z0-9]{8}\.(js|css)$/.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, { etag: a.etag, 'cache-control': cache }); res.end(); return true; }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = gz ? a.gz : a.buf;
    res.writeHead(200, { 'content-type': a.type, 'content-length': body.length, etag: a.etag, 'cache-control': cache, ...(gz ? { 'content-encoding': 'gzip' } : {}), 'referrer-policy': 'no-referrer' });
    res.end(body);
    return true;
  }

  // What the page needs to know before its code runs: where the service is mounted, how people
  // sign in, and whether a git host shares the origin.
  #config() {
    return { base: this.basePath, auth: this.auth.describe().kind, ...(this.forgeUrl === null ? {} : { forge: this.forgeUrl }) };
  }

  #page(buf) {
    return Buffer.from(buf.toString('utf8')
      .replaceAll('"/assets/', `"${this.basePath}/assets/`)
      .replace('<!--CONFIG-->', `<script>window.__LB = ${JSON.stringify(this.#config()).replace(/</g, '\\u003c')};</script>`));
  }

  // The script a git host's pages load to offer "Edit live" (see web/embed.js): the source with
  // this service's addresses filled in. Which repositories are served is given as hashes, so the
  // script can recognise the page it is on without the service listing repository names.
  #embed(req, res) {
    if (!this.embedJs) {
      const index = readFileSync(path.join(this.webDir, 'index.html'), 'utf8');
      const cfg = {
        ...this.#config(),
        entry: `${this.basePath}/assets/${/src="\/assets\/(app-[A-Z0-9]+\.js)"/.exec(index)?.[1]}`,
        css: `${this.basePath}/assets/${/href="\/assets\/(app-[A-Z0-9]+\.css)"/.exec(index)?.[1]}`,
        repos: [...this.bridges.values()].map((b) => ({ id: createHash('sha256').update(b.slug.toLowerCase()).digest('hex'), branch: b.branch })),
      };
      const src = readFileSync(path.join(this.webDir, 'embed.js'), 'utf8').replace('/*CONFIG*/{}', JSON.stringify(cfg));
      this.embedJs = Buffer.from(src);
    }
    res.writeHead(200, { 'content-type': TYPES['.js'], 'content-length': this.embedJs.length, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : this.embedJs);
  }

  async #route(req, res) {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (this.basePath) {
      if (p !== this.basePath && !p.startsWith(`${this.basePath}/`)) return this.#json(res, 404, { error: 'not found' });
      p = p.slice(this.basePath.length) || '/';
    }
    const seg = p.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.method === 'POST' && seg[0] === 'webhook' && (seg[1] === 'github' || seg[1] === 'forgejo')) return this.#webhook(req, res, seg[1]);
    if (req.method === 'POST' && seg[0] === 'internal' && seg[1] === 'poke') {
      if (seg[2] !== this.pokeToken) return this.#json(res, 403, { error: 'forbidden' });
      const b = this.bridges.get(String(url.searchParams.get('repo')).toLowerCase());
      // a hook that names the commit also fires for the bridge's own pushes; those are known already
      const commit = url.searchParams.get('commit');
      if (b && !(commit && b.ownPushes.includes(commit))) b.poke('hook');
      return this.#json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && seg[0] === 'internal' && seg[1] === 'preflush') return this.#preflush(req, res, seg[2], url);
    if (seg[0] === 'auth' && this.auth.handle && await this.auth.handle(req, res, seg, url)) return undefined;
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/embed.js') return this.#embed(req, res);

    if (seg[0] === 'api') {
      if (req.method === 'GET' && seg[1] === 'auth') return this.#json(res, 200, this.auth.describe());
      if (req.method === 'POST' && seg[1] === 'signin') return this.#json(res, 200, this.auth.signIn(JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}')));
      if (req.method === 'GET' && seg[1] === 'status') {
        // local diagnostics for tests and the operator: no document text in here
        return this.#json(res, 200, { ok: true, pid: process.pid, repos: [...this.bridges.values()].map((b) => b.status()) });
      }
      const user = this.#need(req, url);
      if (req.method === 'GET' && seg[1] === 'me') {
        // only the repositories this person may at least read are named
        const repos = [];
        for (const b of this.bridges.values()) if (await this.#access(user, b).catch(() => 'none') !== 'none') repos.push({ owner: b.host.owner, repo: b.host.repo, kind: b.host.kind });
        return this.#json(res, 200, { user: { name: user.name, email: user.email, ...(user.login ? { login: user.login } : {}) }, repos });
      }
      if (seg[1] === 'r' && seg.length >= 5) {
        const b = this.#bridge(seg[2], seg[3]);
        await b.ready;
        // reading needs read access to the repository, everything else push access
        const access = await this.#access(user, b);
        if (access === 'none') throw Object.assign(new Error('no access to this repository'), { status: 403, code: 'NO_ACCESS' });
        const file = url.searchParams.get('path');
        if (req.method === 'GET' && seg[4] === 'tree') return this.#json(res, 200, { ...await b.files(), access });
        if (req.method === 'GET' && seg[4] === 'state') {
          const { update, ...state } = { ...await b.state(file), access };
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': update.length, 'cache-control': 'no-store', 'x-room': Buffer.from(JSON.stringify(state)).toString('base64url') });
          return res.end(Buffer.from(update.buffer, update.byteOffset, update.length));
        }
        if (access !== 'write') throw Object.assign(new Error('no push permission on this repository'), { status: 403, code: 'NO_PUSH' });
        if (req.method === 'POST' && seg[4] === 'close') return this.#json(res, 200, await b.close(file));
        if (req.method === 'POST' && seg[4] === 'orphan') return this.#json(res, 200, await b.orphan(file, user, (await readBody(req)).toString('utf8')));
      }
      return this.#json(res, 404, { error: 'no such endpoint' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return this.#json(res, 405, { error: 'method not allowed' });
    if (seg[0] === 'assets' && this.#static(req, res, seg.slice(1).join('/'))) return undefined;
    // every view has its own URL and all of them are the same page
    if (p === '/' || seg[0] === 'r' || seg[0] === 'signin') { if (this.#static(req, res, 'index.html')) return undefined; }
    return this.#json(res, 404, { error: 'not found' });
  }

  // GitHub signs with X-Hub-Signature-256 ("sha256=<hex>"); Forgejo with X-Forgejo-Signature
  // (the bare hex) and names the event in X-Forgejo-Event.
  async #webhook(req, res, kind) {
    const h = kind === 'forgejo'
      ? { sig: 'x-forgejo-signature', event: 'x-forgejo-event', delivery: 'x-forgejo-delivery' }
      : { sig: 'x-hub-signature-256', event: 'x-github-event', delivery: 'x-github-delivery' };
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return this.#json(res, 400, { error: 'not JSON' }); }
    const name = payload?.repository?.full_name;
    const b = typeof name === 'string' ? this.bridges.get(name.toLowerCase()) : null;
    // the same answer for an unknown repository and a bad signature
    if (!b || b.host.kind !== kind || !b.host.verify(raw, req.headers[h.sig])) {
      this.log.warn(`webhook refused (${b ? 'bad signature' : 'unknown repository'}), delivery ${req.headers[h.delivery] || '-'}`);
      return this.#json(res, 401, { error: 'signature does not match' });
    }
    const done = b.host.webhook(req.headers[h.event], payload);
    this.log.info(`webhook ${req.headers[h.event]} for ${name}: ${done.action}${done.why ? ` (${done.why})` : ''}`);
    return this.#json(res, 202, done);
  }

  // The host's pre-receive hook: old commit, new commit, pusher, the first own commit of the push
  // and the paths it touches, one per line. 409 with a text for the pusher means "turn it away".
  async #preflush(req, res, token, url) {
    if (token !== this.pokeToken) return this.#json(res, 403, { error: 'forbidden' });
    const b = this.bridges.get(String(url.searchParams.get('repo')).toLowerCase());
    const [old, neu, pusher = '', first = '', ...paths] = (await readBody(req, 4 * 1024 * 1024)).toString('utf8').split('\n');
    if (!b || !/^[0-9a-f]{40,64}$/.test(old || '') || !/^[0-9a-f]{40,64}$/.test(neu || '')) return this.#json(res, 200, { allow: true });
    let answer;
    try { answer = await b.preflush({ old, new: neu, pusher, pushId: createHash('sha256').update(`${pusher}\0${first}`).digest('hex'), paths: paths.filter(Boolean) }); } catch (e) {
      // the live text could not be committed: the push is not held up for that
      this.log.error(`preflush for ${b.slug}: ${e.message}`);
      answer = { allow: true };
    }
    if (answer.allow) return this.#json(res, 200, answer);
    const body = Buffer.from(`${answer.message}\n`);
    res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
    return res.end(body);
  }

  #upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    const refuse = (status, text) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (url.pathname !== `${this.basePath}/ws`) return refuse(404, 'Not Found');
    const user = this.#user(req, url);
    if (!user) return refuse(401, 'Unauthorized');
    const b = this.bridges.get(String(url.searchParams.get('repo')).toLowerCase());
    if (!b) return refuse(404, 'Not Found');
    return this.wss.handleUpgrade(req, socket, head, (ws) => this.#socket(ws, b, user, url));
  }

  async #socket(ws, bridge, user, url) {
    ws.binaryType = 'nodebuffer';
    this.sockets.add(ws);
    const early = [];
    let conn = null;
    const send = (data) => { if (ws.readyState === 1) ws.send(data); };
    ws.on('message', (data) => {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
      if (!conn) { early.push(bytes); return; }
      try { bridge.receive(conn, bytes); } catch (e) { this.log.error(`message from ${user.email}: ${e.stack || e.message}`); }
    });
    ws.on('close', () => { this.sockets.delete(ws); if (conn) bridge.disconnect(conn); else conn = false; });
    ws.on('error', () => {});
    try {
      // someone who may read the repository but not push watches the room; nothing they send is applied
      const access = await this.#access(user, bridge);
      if (access === 'none') throw Object.assign(new Error('no access to this repository'), { code: 'NO_ACCESS' });
      const c = await bridge.connect(url.searchParams.get('path'), user, send, { docId: url.searchParams.get('docId') || undefined, readOnly: access !== 'write' });
      if (conn === false) { bridge.disconnect(c); return; }
      conn = c;
      for (const bytes of early) bridge.receive(conn, bytes);
    } catch (e) {
      // 1013: the git host could not be asked right now, the editor tries again by itself
      ws.close(e.code === 'HOST_AWAY' ? 1013 : 1008, String(e.code || 'ERROR').slice(0, 60));
    }
  }
}
