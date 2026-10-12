// Shared by up.mjs, down.mjs and the end-to-end tests: where the stack lives, which processes
// belong to it, and small helpers for Forgejo's HTTP API.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import winston from 'winston';

export const exec = promisify(execFile);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const SERVICE_DIR = path.resolve(ROOT, '..', 'yjs-bridge');
/** Everything the stack writes (Forgejo data, repositories, service state, logs, pids). */
export const HOME = path.resolve(process.env.FORGEJO_LIVE_HOME || path.join(os.tmpdir(), 'forgejo-live'));
export const FORGEJO_BIN = process.env.FORGEJO_BIN || 'forgejo';
export const PARTS = ['forgejo', 'service', 'proxy'];
// ports that belong to somebody else on the machine this was written on
const NEVER = new Set([3000, 3001, 4477]);

export const log = winston.createLogger({
  level: process.env.STACK_LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.printf(({ timestamp, level, message }) => `${timestamp} stack ${level}: ${message}`)),
  transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'debug'] })],
});

export const file = (...p) => path.join(HOME, ...p);

export function readJson(name, fallback = null) {
  try { return JSON.parse(readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

export function writeJson(name, value, mode = 0o600) {
  mkdirSync(path.dirname(file(name)), { recursive: true });
  writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export async function freePort(taken = []) {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    if (!NEVER.has(port) && !taken.includes(port)) return port;
  }
}

export { portFree };

// ---------------------------------------------------------------- processes

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function commandOf(pid) {
  try { return (await exec('ps', ['-p', String(pid), '-o', 'command='])).stdout.trim(); } catch { return ''; }
}

/** The recorded process of `name` if it is still the one that was started (same pid, same command line marker). */
export async function running(name) {
  const rec = readJson('pids.json', {})[name];
  if (!rec || !alive(rec.pid)) return null;
  const cmd = await commandOf(rec.pid);
  return cmd.includes(rec.marker) ? rec : null;
}

// macOS: /usr/bin/git is a launcher that looks up the real git on every call. Started from npx
// (as the tests are) that lookup takes about 80 ms instead of 5, and Forgejo and the service
// start git many times per push. The processes of the stack therefore get the real git's
// directory in front of their PATH.
let gitDir = null;
function realGitPath() {
  if (gitDir !== null) return gitDir;
  gitDir = '';
  if (process.platform === 'darwin') {
    try { gitDir = path.dirname(execFileSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8' }).trim()); } catch { /* no launcher: PATH is used as it is */ }
  }
  return gitDir;
}

/** Starts a process that outlives this script; stdout and stderr go to logs/<name>.log. */
export function start(name, command, args, { env = {}, marker, cwd } = {}) {
  mkdirSync(file('logs'), { recursive: true });
  const out = openSync(file('logs', `${name}.log`), 'a');
  const PATH = [realGitPath(), process.env.PATH].filter(Boolean).join(':');
  const child = spawn(command, args, { cwd, env: { ...process.env, PATH, ...env }, stdio: ['ignore', out, out], detached: true });
  child.unref();
  closeSync(out);
  const pids = readJson('pids.json', {});
  pids[name] = { pid: child.pid, marker, startedAt: new Date().toISOString(), command: [command, ...args].join(' ') };
  writeJson('pids.json', pids);
  return child.pid;
}

/** Stops the recorded process of `name`, and only that one. Returns what happened. */
export async function stop(name, { signal = 'SIGTERM', waitMs = 15000 } = {}) {
  const rec = await running(name);
  const pids = readJson('pids.json', {});
  if (!rec) {
    if (pids[name]) { delete pids[name]; writeJson('pids.json', pids); }
    return 'not running';
  }
  process.kill(rec.pid, signal);
  const t0 = Date.now();
  while (alive(rec.pid) && Date.now() - t0 < waitMs) await sleep(50);
  if (alive(rec.pid)) { process.kill(rec.pid, 'SIGKILL'); await sleep(200); }
  delete pids[name];
  writeJson('pids.json', pids);
  return `stopped pid ${rec.pid}`;
}

export async function waitFor(fn, what, ms = 60000, step = 150) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timeout after ${ms} ms waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await sleep(step);
  }
}

// ---------------------------------------------------------------- Forgejo

export const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** One call to Forgejo's API. `as` is {user, password} or {token}. Throws on a status outside `ok`. */
export async function api(base, method, route, { as, body, ok = [200, 201, 204] } = {}) {
  const headers = { accept: 'application/json' };
  if (as?.token) headers.authorization = `token ${as.token}`;
  else if (as?.user) headers.authorization = basic(as.user, as.password);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${base}/api/v1${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!ok.includes(r.status)) throw new Error(`${method} ${route} -> ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, json };
}

/** Runs the Forgejo command line against this stack's instance. */
export function forgejo(args, opts = {}) {
  return exec(FORGEJO_BIN, ['--work-path', file('forgejo'), '--config', file('forgejo', 'custom', 'conf', 'app.ini'), ...args], { maxBuffer: 16 * 1024 * 1024, ...opts });
}

/**
 * git with credentials in the environment (never on the command line). The empty
 * credential.helper clears the list of helpers: git neither asks nor tells a keychain or a
 * credential cache, whatever the machine's git configuration says.
 */
export async function git(cwd, args, { as, allowFail = false, env = {} } = {}) {
  const auth = { GIT_CONFIG_COUNT: as ? '2' : '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', ...(as ? { GIT_CONFIG_KEY_1: 'http.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: ${basic(as.user, as.token || as.password)}` } : {}) };
  try {
    const r = await exec('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...auth, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return allowFail ? { code: 0, stdout: r.stdout, stderr: r.stderr } : r.stdout;
  } catch (e) {
    if (allowFail && typeof e.code === 'number') return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    throw new Error(`git ${args.join(' ')} in ${cwd}: ${e.stderr || e.message}`);
  }
}

export function stackInfo() {
  const ports = readJson('ports.json');
  const accounts = readJson('accounts.json');
  if (!ports || !accounts) return null;
  return {
    home: HOME,
    ports,
    publicUrl: `http://127.0.0.1:${ports.proxy}`,
    forgejoUrl: `http://127.0.0.1:${ports.forgejo}`,
    serviceUrl: `http://127.0.0.1:${ports.service}`,
    repo: accounts.repo,
    accounts,
    repoDir: file('forgejo', 'repositories', `${accounts.repo.toLowerCase()}.git`),
  };
}

export { existsSync };
