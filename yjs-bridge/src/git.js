// Thin wrapper around the git command line for the bridge's own bare clone. Commits are built with
// plumbing (fast-import), so there is no working tree to keep clean.
// Nothing in here ever passes --force or a "+" refspec to push.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(' ')} exited with ${code}: ${stderr.trim()}`);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export class Git {
  constructor(dir, { log, env = {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.env = env;
    this.net = Promise.resolve();
    this.seq = 0;
  }

  /** Runs git in the clone. Resolves with {code, stdout, stderr}; rejects on a non-zero exit unless allowFail. */
  run(args, { input, env, allowFail = false, cwd, raw = false } = {}) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('git', cwd ? args : ['--git-dir', this.dir, ...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...this.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => {
        this.log?.debug(`git ${args[0]} -> ${code} in ${Date.now() - t0} ms`);
        const res = { code, stdout: raw ? '' : Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
        if (raw) res.stdoutRaw = Buffer.concat(out);
        if (code !== 0 && !allowFail) reject(new GitError(args, code, res.stderr));
        else resolve(res);
      });
      child.stdin.on('error', () => { /* git closed its stdin first */ });
      child.stdin.end(input ?? '');
    });
  }

  async init(remote) {
    if (!existsSync(path.join(this.dir, 'HEAD'))) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      await this.run(['init', '--bare', '--quiet', this.dir], { cwd: path.dirname(this.dir) });
      await this.run(['remote', 'add', 'origin', remote]);
    } else {
      await this.run(['remote', 'set-url', 'origin', remote]);
      // throwaway refs of a bridge that was killed before it removed them (the commits stay as objects)
      const refs = (await this.run(['for-each-ref', '--format=delete %(refname)', 'refs/bridge/tmp/'])).stdout;
      if (refs) await this.run(['update-ref', '--stdin'], { input: refs, allowFail: true });
    }
  }

  // Fetch and push both write refs/remotes/origin/<branch>; the poll fetches outside the bridge's
  // queue, so the commands that talk to the host go one at a time.
  #oneAtATime(fn) {
    const run = this.net.then(fn);
    this.net = run.catch(() => {});
    return run;
  }

  /** Fetches the branch into refs/remotes/origin/<branch> (fast-forward only) and returns its commit, or null if the remote has no such branch. */
  fetch(branch, { from = 'origin' } = {}) { return this.#oneAtATime(() => this.#fetch(branch, from)); }

  // `from` is the remote, or another address of the same repository (its directory on this machine)
  async #fetch(branch, from) {
    const r = await this.run(['fetch', '--quiet', '--no-tags', from, `refs/heads/${branch}:refs/remotes/origin/${branch}`], { allowFail: true });
    if (r.code !== 0) {
      if (/couldn't find remote ref/.test(r.stderr)) return null;
      throw new GitError(['fetch'], r.code, r.stderr);
    }
    return this.resolve(`refs/remotes/origin/${branch}`);
  }

  async remoteTip(branch) {
    const r = await this.run(['ls-remote', 'origin', `refs/heads/${branch}`]);
    const m = /^([0-9a-f]{40,64})\s/.exec(r.stdout);
    return m ? m[1] : null;
  }

  async resolve(rev) {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async isAncestor(a, b) {
    const r = await this.run(['merge-base', '--is-ancestor', a, b], { allowFail: true });
    return r.code === 0;
  }

  /** Text of `file` at `commit`, or null when the commit has no such file. */
  async textAt(commit, file) {
    const r = await this.run(['cat-file', 'blob', `${commit}:${file}`], { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  }

  /** {mode, blob} of `file` at `commit`, or null when the commit has no such file (or it is not a blob). */
  async entryAt(commit, file) {
    const r = await this.run(['ls-tree', '-z', commit, '--', file], { allowFail: true });
    const m = r.code === 0 ? /^(\d{6}) blob ([0-9a-f]{40,64})\t/.exec(r.stdout) : null;
    return m ? { mode: m[1], blob: m[2] } : null;
  }

  async blobText(blob) {
    return (await this.run(['cat-file', 'blob', blob])).stdout;
  }

  /** The bytes of a blob, for the "is this text" check. */
  async blobBytes(blob) {
    return (await this.run(['cat-file', 'blob', blob], { raw: true })).stdoutRaw;
  }

  /** Commits in base..tip that changed `file`, newest first, with their authors. */
  async commitsTouching(base, tip, file) {
    const r = await this.run(['log', '--format=%H%x09%an%x09%ae', `${base}..${tip}`, '--', file], { allowFail: true });
    if (r.code !== 0) return [];
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [commit, name, email] = l.split('\t'); return { commit, name, email }; });
  }

  async authorOf(commit) {
    const r = await this.run(['log', '-1', '--format=%an%x09%ae', commit], { allowFail: true });
    const [name = '', email = ''] = r.stdout.trim().split('\t');
    return { name, email };
  }

  /** Paths of the regular files in `commit`. */
  async listFiles(commit) {
    const r = await this.run(['ls-tree', '-r', '-z', commit]);
    return r.stdout.split('\0').filter(Boolean).map((l) => { const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(l); return m ? { mode: m[1], type: m[2], path: m[4] } : null; }).filter((e) => e && e.type === 'blob' && e.mode.startsWith('100'));
  }

  /**
   * Builds a commit whose tree is `parent`'s tree with `file` replaced by `text`. Local only, one
   * git process (fast-import). The commit hangs on a throwaway ref under refs/bridge/tmp/ that is
   * removed a minute later.
   * @returns {Promise<string>} the commit hash
   */
  async commitFile({ parent, file, text, author, committer, message, date, mode = '100644' }) {
    const when = `${Math.floor((date ? new Date(date) : new Date()).getTime() / 1000)} +0000`;
    const ident = (p) => `${String(p.name).replace(/[<>\n]/g, '').trim() || 'unknown'} <${String(p.email).replace(/[<>\n\s]/g, '')}>`;
    // fast-import reads a path up to the end of the line; one with a quote, backslash or line break is C-quoted
    const quoted = /^"|[\n\\"]/.test(file) ? `"${file.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : file;
    const ref = `refs/bridge/tmp/${process.pid}-${++this.seq}-${Date.now()}`;
    const msg = Buffer.from(message, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const input = Buffer.concat([
      Buffer.from(`commit ${ref}\nmark :1\nauthor ${ident(author)} ${when}\ncommitter ${ident(committer)} ${when}\ndata ${msg.length}\n`), msg,
      Buffer.from(`\nfrom ${parent}\nM ${mode} inline ${quoted}\ndata ${data.length}\n`), data,
      Buffer.from('\n\nget-mark :1\n'),
    ]);
    const r = await this.run(['fast-import', '--quiet', '--date-format=raw'], { input });
    const commit = r.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitError(['fast-import'], 0, `no commit hash in the output: ${r.stdout} ${r.stderr}`);
    setTimeout(() => { this.run(['update-ref', '-d', ref], { allowFail: true }).catch(() => {}); }, 60000).unref();
    return commit;
  }

  /**
   * Ordinary push of one commit to one ref. The remote accepts it only as a fast-forward (or as a
   * new ref), which makes it the compare-and-swap of the design.
   * @returns {Promise<{ok: boolean, reason?: string, stderr?: string}>}
   */
  push(commit, ref, { env = {} } = {}) { return this.#oneAtATime(() => this.#push(commit, ref, env)); }

  async #push(commit, ref, env) {
    const r = await this.run(['push', '--porcelain', 'origin', `${commit}:${ref}`], { allowFail: true, env: { LIVE_BRIDGE_OWN_PUSH: '1', ...env } });
    if (r.code === 0) return { ok: true };
    const line = r.stdout.split('\n').find((l) => l.startsWith('!')) || '';
    const reason = /\[(?:remote )?rejected\] \((.*)\)/.exec(line)?.[1] || /\((.*)\)\s*$/.exec(line)?.[1] || 'push failed';
    return { ok: false, reason, stderr: r.stderr };
  }

}
