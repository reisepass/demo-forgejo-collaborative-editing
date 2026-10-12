// Who is editing, and may they write to this repository?
//
// Interface (what the server uses):
//   signIn(body)             -> {token, user} or throws        POST /api/signin
//   authenticate(token)      -> {name, email} or null          every API call and websocket
//   canWrite(user, host)     -> Promise<boolean>               before a room is joined
//   describe()               -> {kind, ...} for the sign-in page
// Optional, for an implementation that knows more than yes or no (see auth-forgejo.js):
//   access(user, host)       -> Promise<'write'|'read'|'none'> 'read' joins a room as a watcher
//   handle(req, res, seg, url)  its own routes under /auth/
//   cookieName               the session travels in this cookie instead of a bearer token
//
// DevAuth is the prototype: anyone picks a name and an email address and may write. The real
// implementation is "Sign in with GitHub": the OAuth web flow of a GitHub App gives a user token,
// name and email come from GET /user (+ /user/emails), and canWrite asks
// GET /repos/{owner}/{repo} with that token and takes permissions.push.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export class DevAuth {
  constructor({ stateDir }) {
    // the signing key stays the same across restarts, so a browser that was signed in stays signed in
    const file = path.join(stateDir, 'dev-auth.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.key = readFileSync(file, 'utf8').trim();
  }

  describe() { return { kind: 'dev', note: 'Development sign-in: no password, anyone may write.' }; }

  #mac(payload) { return createHmac('sha256', this.key).update(payload).digest(); }

  signIn(body) {
    const name = String(body?.name || '').replace(/[<>\n\r]/g, '').trim();
    const email = String(body?.email || '').replace(/[<>\s]/g, '');
    if (!name || !/^[^@]+@[^@]+$/.test(email)) {
      const e = new Error('a name and an email address are needed (commits are authored as this person)');
      e.status = 400;
      throw e;
    }
    const payload = b64(JSON.stringify({ name, email }));
    return { token: `${payload}.${b64(this.#mac(payload))}`, user: { name, email } };
  }

  authenticate(token) {
    const [payload, mac] = String(token || '').split('.');
    if (!payload || !mac) return null;
    const want = this.#mac(payload);
    const got = Buffer.from(mac, 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try { const u = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return { name: u.name, email: u.email }; } catch { return null; }
  }

  async canWrite() { return true; }
}
