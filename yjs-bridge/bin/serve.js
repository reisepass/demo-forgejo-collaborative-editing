#!/usr/bin/env node
// Starts the service for one repository.
//
//   serve.js --local <bare repo dir> [--name owner/repo]
//   serve.js --github <owner>/<repo> [--webhook-secret-env NAME]
//   serve.js --forgejo <url> --repo <owner>/<repo> [--repo ...] --public-url <url> [--base-path /live] [--repos-root <dir>]
//     with LIVE_FORGEJO_BOT_USER, LIVE_FORGEJO_BOT_TOKEN, LIVE_FORGEJO_OAUTH_CLIENT_ID and
//     LIVE_FORGEJO_OAUTH_CLIENT_SECRET in the environment (and the webhook secret, see below)
//
// One JSON line per bridge event goes to stdout, the log to stderr.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { Bridge } from '../src/bridge.js';
import { Service } from '../src/server.js';
import { DevAuth } from '../src/auth.js';
import { LocalHost } from '../src/hosts/local.js';
import { GitHubHost } from '../src/hosts/github.js';
import { ForgejoHost } from '../src/hosts/forgejo.js';
import { ForgejoAuth } from '../src/auth-forgejo.js';
import { makeLogger } from '../src/logger.js';

const num = (v) => Number(v);
const program = new Command()
  .option('--local <dir>', 'bare repository on local disk')
  .option('--github <owner/repo>', 'repository on GitHub (git over SSH)')
  .option('--forgejo <url>', 'Forgejo instance, as the service reaches it (sign-in and pushes go through it)')
  .option('--repo <owner/repo...>', 'repository on the Forgejo instance; may be given several times')
  .option('--repos-root <dir>', "Forgejo's repository root on this machine (like --repo-dir, for every --repo)")
  .option('--public-url <url>', 'the address people use for Forgejo and, under the base path, for the editor')
  .option('--base-path <path>', 'path prefix of every route of this service, e.g. /live', '')
  .option('--repo-dir <dir>', 'the Forgejo repository on this machine: installs the post-receive poke and the demand-flush pre-receive hook')
  .option('--no-poke-hook', 'with --repo-dir: no post-receive poke (the webhook and polling remain)')
  .option('--no-demand-flush', 'with --repo-dir: no pre-receive demand flush')
  .option('--bridge-name <name>', 'committer name of the commits the service makes')
  .option('--bridge-email <email>', 'committer email of the commits the service makes')
  .option('--name <owner/repo>', 'URL name of a local repository')
  .option('--remote-url <url>', 'git remote URL of the GitHub repository (default git@github.com:<owner>/<repo>.git)')
  .requiredOption('--state <dir>', 'state directory (rooms, clone); outside any repository')
  .option('--port <n>', 'port, 0 picks a free one', num, 4477)
  .option('--host <addr>', 'address to listen on', '127.0.0.1')
  .option('--debounce-ms <n>', 'typing pause before a commit', num, 5000)
  .option('--max-wait-ms <n>', 'longest wait while typing continues', num, 60000)
  .option('--hold-ms <n>', 'a clashing change waits until nobody typed for this long; 0 swaps at once', num, 700)
  .option('--poll-ms <n>', 'how often main is polled', num)
  .option('--empty-ms <n>', 'session ends this long after the last editor left', num, 30000)
  .option('--join-grace-ms <n>', 'session nobody connected to ends after this long', num, 30000)
  .option('--idle-ms <n>', 'session without edits ends after this long', num, 1800000)
  .option('--no-hooks', 'do not install post-receive into a local repository')
  .option('--webhook-secret-env <name>', 'environment variable holding the webhook secret (GitHub or Forgejo)', 'LIVE_BRIDGE_WEBHOOK_SECRET')
  .parse();
const o = program.opts();

const log = makeLogger('service');
const stateDir = path.resolve(o.state);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

let hosts = [];
let auth = null;
const env = (name) => { const v = process.env[name]; if (!v) { log.error(`${name} is not set`); process.exit(2); } return v; };
if (o.forgejo) {
  const repos = (o.repo || []).map((r) => r.split('/'));
  if (!repos.length || repos.some(([owner, repo]) => !owner || !repo) || !o.publicUrl) { log.error('--forgejo needs --repo owner/repo and --public-url'); process.exit(2); }
  auth = new ForgejoAuth({ stateDir, baseUrl: o.forgejo, publicUrl: o.publicUrl, basePath: o.basePath, clientId: env('LIVE_FORGEJO_OAUTH_CLIENT_ID'), clientSecret: env('LIVE_FORGEJO_OAUTH_CLIENT_SECRET'), logger: makeLogger('auth') });
  hosts = repos.map(([owner, repo]) => new ForgejoHost({
    baseUrl: o.forgejo,
    owner,
    repo,
    botUser: env('LIVE_FORGEJO_BOT_USER'),
    botToken: env('LIVE_FORGEJO_BOT_TOKEN'),
    webhookSecret: process.env[o.webhookSecretEnv] || '',
    // Forgejo calls the service directly, not through the public address
    webhookUrl: `http://${o.host === '0.0.0.0' ? '127.0.0.1' : o.host}:${o.port}${o.basePath}/webhook/forgejo`,
    tokenFor: (email) => auth.tokenFor(email),
    // Forgejo keeps repositories under lower-case names
    repoDir: o.reposRoot ? path.join(o.reposRoot, owner.toLowerCase(), `${repo.toLowerCase()}.git`) : repos.length === 1 ? o.repoDir || '' : '',
    pokeHook: o.pokeHook,
    demandFlush: o.demandFlush,
  }));
} else if (o.local) {
  const [owner, repo] = (o.name || '').split('/');
  hosts = [new LocalHost({ dir: o.local, owner: owner || undefined, repo: repo || undefined, hooks: o.hooks })];
} else if (o.github) {
  const [owner, repo] = o.github.split('/');
  if (!owner || !repo) { log.error('--github needs owner/repo'); process.exit(2); }
  hosts = [new GitHubHost({ owner, repo, url: o.remoteUrl, webhookSecret: process.env[o.webhookSecretEnv] || '' })];
} else { log.error('one of --local, --github or --forgejo is needed'); process.exit(2); }

const bridges = hosts.map((host) => {
  const bridge = new Bridge({
    host,
    stateDir: path.join(stateDir, `${host.owner}__${host.repo}`),
    debounceMs: o.debounceMs,
    maxWaitMs: o.maxWaitMs,
    holdMs: o.holdMs,
    pollMs: o.pollMs ?? (host.kind === 'local' ? 2500 : 3000),
    openFreshMs: host.kind === 'forgejo' ? 0 : undefined,
    emptyMs: o.emptyMs,
    joinGraceMs: o.joinGraceMs,
    idleMs: o.idleMs,
    bridgeName: o.bridgeName,
    bridgeEmail: o.bridgeEmail,
    logger: makeLogger('bridge'),
  });
  bridge.on('event', (e) => process.stdout.write(`${JSON.stringify(e)}\n`));
  mkdirSync(bridge.stateDir, { recursive: true, mode: 0o700 });
  return bridge;
});
const host = hosts[0];

const service = new Service({
  bridges,
  auth: auth || new DevAuth({ stateDir }),
  basePath: o.basePath,
  publicUrl: o.publicUrl || '',
  // Forgejo's pages are on the same origin, at its root
  forgeUrl: o.forgejo ? '' : null,
  webDir: fileURLToPath(new URL('../dist', import.meta.url)),
  port: o.port,
  host: o.host,
  logger: makeLogger('http'),
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: flushing and stopping`);
  try { await service.stop(); } catch (e) { log.error(e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

try {
  await service.start();
  process.stdout.write(`${JSON.stringify({ event: 'listening', origin: service.origin, port: service.port, url: `${service.origin}${o.basePath}/r/${host.owner}/${host.repo}`, pid: process.pid })}\n`);
} catch (e) {
  log.error(`not started: ${e.stack || e.message}`);
  process.exit(1);
}
