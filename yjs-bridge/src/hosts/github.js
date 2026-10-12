// A repository on GitHub.
//
// Reading and writing: the git command over SSH with whatever key the machine's SSH setup offers
// for github.com (a deploy key with write access in a real installation), one connection reused
// for all commands. Writes are ordinary pushes, never forced.
//
// Moves of main: GitHub calls POST /webhook/github (event "push", signed with the shared secret);
// the bridge also polls, which is the only path that works where GitHub cannot reach the service.
import { createHmac, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { GitHost } from './base.js';

export class GitHubHost extends GitHost {
  /**
   * @param {object} o
   * @param {string} o.owner
   * @param {string} o.repo
   * @param {string} [o.url] remote URL, default git@github.com:<owner>/<repo>.git
   * @param {string} [o.webhookSecret] shared secret of the repository webhook
   */
  constructor({ owner, repo, url, webhookSecret = '' }) {
    super({ kind: 'github', owner, repo, url: url || `git@github.com:${owner}/${repo}.git` });
    this.webhookSecret = webhookSecret;
    this.onMove = null;
    this.branch = 'main';
  }

  gitEnv() {
    if (process.env.GIT_SSH_COMMAND || /^(https?|file):/.test(this.url)) return {};
    // every git command would otherwise open a new connection; one shared connection takes the
    // handshake out of every poll and push
    const dir = os.tmpdir().length > 30 ? '/tmp' : os.tmpdir();
    return { GIT_SSH_COMMAND: `ssh -o ControlMaster=auto -o ControlPersist=120 -o ControlPath=${path.join(dir, 'lbr-%C')}` };
  }

  async watch({ onMove, branch = 'main' }) {
    this.onMove = onMove;
    this.branch = branch;
    return this.webhookSecret ? ['webhook'] : [];
  }

  async unwatch() { this.onMove = null; }

  /** True when `signature` (the X-Hub-Signature-256 header) is the HMAC of the raw body. */
  verify(rawBody, signature) {
    if (!this.webhookSecret || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
    const want = Buffer.from(`sha256=${createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')}`);
    const got = Buffer.from(signature);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /**
   * A verified webhook delivery. Returns what was done with it.
   * @param {string} event the X-GitHub-Event header
   * @param {object} payload
   */
  webhook(event, payload) {
    if (event === 'ping') return { ok: true, action: 'pong' };
    if (event !== 'push') return { ok: true, action: 'ignored', why: `event ${event}` };
    if (payload?.ref !== `refs/heads/${this.branch}`) return { ok: true, action: 'ignored', why: `ref ${payload?.ref}` };
    if (payload.deleted) return { ok: true, action: 'ignored', why: 'branch deleted' };
    this.onMove?.('webhook', payload.after);
    return { ok: true, action: 'poked', after: payload.after };
  }
}
