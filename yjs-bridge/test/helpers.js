// Test world: a bare repository on disk as the git host, agent clones driven by the real git
// command, the service as its own process, and headless Yjs clients playing humans.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Human, signIn } from './human.js';

const exec = promisify(execFile);

export const SCRATCH = process.env.BRIDGE_SCRATCH || path.join(os.tmpdir(), 'yjs-bridge-tests');
export const SERVE = fileURLToPath(new URL('../bin/serve.js', import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, what, ms = 20000, step = 20) {
  const t = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() - t > ms) throw new Error(`timeout after ${ms} ms waiting for ${what}`);
    await sleep(step);
  }
}

// one SSH connection per host is reused by all test git commands (matters only for a remote host)
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || `ssh -o ControlMaster=auto -o ControlPersist=120 -o ControlPath=${path.join(os.tmpdir().length > 30 ? '/tmp' : os.tmpdir(), 'lbr-%C')}` };

/** Runs git; resolves with stdout. With allowFail resolves with {code, stdout, stderr} instead of throwing. */
export async function git(cwd, args, { allowFail = false, env } = {}) {
  try {
    const r = await exec('git', args, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return allowFail ? { code: 0, stdout: r.stdout, stderr: r.stderr } : r.stdout;
  } catch (e) {
    if (allowFail && typeof e.code === 'number') return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    throw new Error(`git ${args.join(' ')} in ${cwd}: ${e.stderr || e.message}`);
  }
}

export const DOC = '# Shared notes\n\n' + Array.from({ length: 20 }, (_, i) => `line ${String(i + 1).padStart(2, '0')} original`).join('\n') + '\n';

export class Agent {
  constructor(world, name, dir) { this.world = world; this.name = name; this.dir = dir; this.rejected = 0; }
  git(args, opts) { return git(this.dir, args, opts); }
  read(file) { return readFileSync(path.join(this.dir, file), 'utf8'); }
  write(file, text) { mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true }); writeFileSync(path.join(this.dir, file), text); }
  async pull() { await this.git(['pull', '--quiet', '--rebase', 'origin', 'main']); }
  /** Edits a file with fn(text), commits, pushes; on a rejected push rebases and pushes again. Returns the commit that landed. */
  async change(file, fn, message = `${this.name}: edit ${file}`) {
    await this.pull();
    this.write(file, fn(this.read(file)));
    await this.git(['add', '--', file]);
    await this.git(['commit', '--quiet', '-m', message]);
    return this.push();
  }
  async push() {
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await this.git(['push', '--quiet', 'origin', 'HEAD:main'], { allowFail: true });
      this.lastPushMs = performance.now() - t0;
      if (r.code === 0) return (await this.git(['rev-parse', 'HEAD'])).trim();
      this.rejected += 1;
      this.lastReject = r.stderr;
      (this.rejections ||= []).push({ ms: Math.round(this.lastPushMs), stderr: r.stderr, byBridge: /bridge:/.test(r.stderr) });
      // `merge` makes this agent answer a rejection with a merge commit instead of a rebase
      await this.git(['pull', '--quiet', this.merge ? '--no-rebase' : '--rebase', '--no-edit', 'origin', 'main']);
    }
    throw new Error(`${this.name}: push still rejected after 20 tries: ${this.lastReject}`);
  }
}

/**
 * With `remote` (an SSH URL of a repository on a real host) the host is that repository: `bare`
 * is then only a local mirror used to look at the host, refreshed before every look. The test
 * files are reset by an ordinary commit, and only conflict branches made after that count.
 */
export async function makeWorld(name, { files = { 'docs/x.md': DOC, 'docs/other.md': 'other file\n', 'README.md': 'readme\n' }, remote = null } = {}) {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(path.join(SCRATCH, `${name}-`));
  const bare = path.join(dir, remote ? 'mirror.git' : 'origin.git');
  if (remote) {
    await git(dir, ['clone', '--quiet', '--mirror', remote, bare]);
    await git(bare, ['config', 'core.logAllRefUpdates', 'always']);
  } else {
    await git(dir, ['init', '--quiet', '--bare', '-b', 'main', bare]);
    // every ref update of the host is recorded, so a forced update could not go unnoticed
    await git(bare, ['config', 'core.logAllRefUpdates', 'always']);
  }
  const refresh = async () => { if (remote) await git(bare, ['fetch', '--quiet', '--prune', 'origin']); };
  const slug = remote ? /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote)[1] : `local/${name}`;
  const world = {
    dir, bare, remote, slug, repo: remote || bare, state: path.join(dir, 'state'), bridges: [], agents: [], humans: [], oldBranches: new Set(), startedAt: new Date(),
    async clone(agentName) {
      const d = path.join(dir, `clone-${agentName}`);
      await git(dir, ['clone', '--quiet', world.repo, d]);
      await git(d, ['config', 'user.name', `Agent ${agentName}`]);
      await git(d, ['config', 'user.email', `${agentName}@agents.test`]);
      const a = new Agent(world, agentName, d);
      world.agents.push(a);
      return a;
    },
    /** Text of a file on the host's main (or another ref), null when missing. */
    async main(file, ref = 'main') {
      await refresh();
      const r = await git(bare, ['cat-file', 'blob', `${ref}:${file}`], { allowFail: true });
      return r.code === 0 ? r.stdout : null;
    },
    async tip(ref = 'main') { await refresh(); return (await git(bare, ['rev-parse', ref])).trim(); },
    async commitInfo(rev) {
      await refresh();
      const [an, ae, cn, ce, parents, subject, ...body] = (await git(bare, ['log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%P%n%s%n%b', rev])).split('\n');
      return { an, ae, cn, ce, parents: parents.split(' ').filter(Boolean), subject, body: body.join('\n').trim() };
    },
    async branches(prefix = 'conflict/') {
      await refresh();
      return (await git(bare, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`])).split('\n').filter((b) => b && !world.oldBranches.has(b));
    },
    /** `git log` of the commits made since this world was set up, newest first. */
    async logSince(format = '%an') {
      await refresh();
      return (await git(bare, ['log', `--format=${format}`, `${world.seed}..main`])).trim().split('\n').filter(Boolean);
    },
    /** Every update of main recorded by the host must be a fast-forward. Returns the number of updates checked. */
    async assertMainOnlyMovedForward() {
      // A remote host: the mirror records every commit of main it has seen (it is refreshed before
      // every look at the host). If main had been rewritten, a commit seen earlier would not be
      // an ancestor of one seen later.
      if (remote) await refresh();
      const reflog = path.join(bare, 'logs', 'refs', 'heads', 'main');
      const lines = existsSync(reflog) ? readFileSync(reflog, 'utf8').split('\n').filter(Boolean) : [];
      let n = 0;
      for (const l of lines) {
        const [old, neu] = l.split(' ');
        if (/^0+$/.test(old)) continue;
        const r = await git(bare, ['merge-base', '--is-ancestor', old, neu], { allowFail: true });
        if (r.code !== 0) throw new Error(`main was moved from ${old} to ${neu}, which is not a fast-forward`);
        n += 1;
      }
      return n;
    },
    /** What a brand-new clone of the host holds: {tip, text(file)}; the checkout is in a new directory every time. */
    async freshClone(ref = 'main') {
      const d = mkdtempSync(path.join(dir, 'fresh-'));
      await git(dir, ['clone', '--quiet', '--branch', ref, '--single-branch', world.repo, d]);
      return { dir: d, tip: (await git(d, ['rev-parse', 'HEAD'])).trim(), text: (file) => readFileSync(path.join(d, file), 'utf8'), git: (args) => git(d, args) };
    },
    startBridge(opts = {}) { return startBridge(world, opts); },
    async stop() { for (const h of world.humans) h.close(); for (const b of world.bridges) await b.stop(); },
  };
  const seed = await world.clone('seed');
  for (const [file, text] of Object.entries(files)) seed.write(file, text);
  await seed.git(['add', '-A']);
  if ((await seed.git(['status', '--porcelain'])).trim()) await seed.git(['commit', '--quiet', '-m', remote ? `Reset test files (${name})` : 'Seed']);
  await seed.push();
  world.seed = await world.tip();
  for (const b of await world.branches()) world.oldBranches.add(b);
  return world;
}

/** Starts the service as a child process and waits until it listens. */
export async function startBridge(world, { debounceMs = 1000, maxWaitMs = 60000, pollMs = 60000, emptyMs = 600000, joinGraceMs = 600000, idleMs = 1800000, hooks = true, holdMs = 0, port = 0, env = {}, expectReady = true, asGithub = false } = {}) {
  // asGithub: the GitHub adapter (webhook, polling, no hook) with a repository on disk as its remote
  const target = world.remote ? ['--github', world.slug, '--remote-url', world.remote] : asGithub ? ['--github', world.slug, '--remote-url', world.bare] : ['--local', world.bare, '--name', world.slug];
  const args = [SERVE, ...target, '--state', world.state, '--port', String(port),
    '--debounce-ms', String(debounceMs), '--max-wait-ms', String(maxWaitMs), '--poll-ms', String(pollMs), '--empty-ms', String(emptyMs),
    '--join-grace-ms', String(joinGraceMs), '--idle-ms', String(idleMs), '--hold-ms', String(holdMs), ...(hooks ? [] : ['--no-hooks'])];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const logFile = path.join(world.dir, 'service.log');
  const b = { child, events: [], stderr: '', exited: null, pid: child.pid, origin: null, slug: world.slug };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf('\n')) !== -1; buf = buf.slice(nl + 1)) {
      const line = buf.slice(0, nl);
      try { b.events.push({ ...JSON.parse(line), seenAt: Date.now() }); } catch { /* not an event */ }
      appendFileSync(logFile, `OUT ${line}\n`);
    }
  });
  child.stderr.on('data', (d) => { b.stderr += d; appendFileSync(logFile, String(d)); });
  b.exit = new Promise((res) => child.on('close', (code, signal) => { b.exited = { code, signal }; res(b.exited); }));
  b.count = (name) => b.events.filter((e) => e.event === name).length;
  b.of = (name) => b.events.filter((e) => e.event === name);
  b.waitFor = (name, pred = () => true, ms = 20000) => until(() => b.events.find((e) => e.event === name && pred(e)), `bridge event ${name}`, ms);
  b.status = async () => (await (await fetch(`${b.origin}/api/status`)).json()).repos[0];
  b.session = async (file = 'docs/x.md') => (await b.status()).sessions.find((s) => s.path === file);
  b.human = async (file = 'docs/x.md', name = 'Ada Human', email = 'ada@humans.test', opts = {}) => {
    const h = await Human.join(b.origin, world.slug, file, { name, email, ...opts });
    world.humans.push(h);
    return h;
  };
  /** The text a newly arriving editor gets. */
  b.fresh = async (file = 'docs/x.md') => {
    const h = await Human.join(b.origin, world.slug, file, { name: 'Reader', email: 'reader@humans.test', connect: false });
    const t = h.text();
    h.awareness.destroy();
    return t;
  };
  b.close = async (file) => {
    const token = await signIn(b.origin, 'Operator', 'operator@humans.test');
    const r = await fetch(`${b.origin}/api/r/${world.slug}/close?path=${encodeURIComponent(file)}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, json: await r.json() };
  };
  b.kill = async (signal = 'SIGKILL') => { child.kill(signal); await b.exit; };
  b.stop = async () => { if (!b.exited) { child.kill('SIGTERM'); await b.exit; } };
  world.bridges.push(b);
  if (expectReady) {
    const l = await Promise.race([b.waitFor('listening', undefined, 60000), b.exit.then((x) => { throw new Error(`service exited ${JSON.stringify(x)}: ${b.stderr}`); })]);
    b.origin = l.origin;
    b.port = l.port;
  }
  return b;
}

export const replaceLine = (n, text) => (doc) => doc.split('\n').map((l) => (l.startsWith(`line ${String(n).padStart(2, '0')} `) ? text : l)).join('\n');
export const lineOf = (doc, n) => doc.split('\n').find((l) => l.startsWith(`line ${String(n).padStart(2, '0')} `));
