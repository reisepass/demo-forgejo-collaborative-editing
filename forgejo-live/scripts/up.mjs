#!/usr/bin/env node
// Brings up the prototype: Forgejo, the editor service and the reverse proxy in front of both.
// Starts from nothing in an empty home folder and reuses whatever is already there.
//
//   node scripts/up.mjs [--only forgejo|service|proxy] [--quiet]
//
// Environment: FORGEJO_LIVE_HOME (data folder), FORGEJO_BIN (the Forgejo binary),
// LIVE_DEBOUNCE_MS, LIVE_MAX_WAIT_MS, LIVE_HOLD_MS, LIVE_POLL_MS, LIVE_EMPTY_MS (service timing),
// LIVE_NO_WEBHOOK=1, LIVE_NO_POKE_HOOK=1 (no post-receive hook), LIVE_NO_DEMAND_FLUSH=1 (no
// pre-receive hook), LIVE_NO_REPO_DIR=1 (the service does not touch the repository's directory:
// no hooks, reads over HTTP), LIVE_FORGEJO_QUEUES=default (leave Forgejo's queues as they come; only read
// when the configuration is first written).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  FORGEJO_BIN, HOME, PARTS, ROOT, SERVICE_DIR, api, existsSync, file, forgejo, freePort, git, log, portFree,
  readJson, running, start, stackInfo, waitFor, writeJson,
} from './lib.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const quiet = args.includes('--quiet');
if (only && !PARTS.includes(only)) { log.error(`--only takes one of ${PARTS.join(', ')}`); process.exit(2); }
const wanted = (part) => !only || only === part;

const REPO = 'acme/handbook';
const PEOPLE = [
  { user: 'root', fullName: 'Root Admin', email: 'root@example.test', admin: true, role: 'site administrator' },
  { user: 'ada', fullName: 'Ada Lovelace', email: 'ada@example.test', permission: 'write', role: 'may push' },
  { user: 'bob', fullName: 'Bob Builder', email: 'bob@example.test', permission: 'write', role: 'may push' },
  { user: 'carol', fullName: 'Carol Reader', email: 'carol@example.test', permission: 'read', role: 'read only' },
  { user: 'agent', fullName: 'Coding Agent', email: 'agent@example.test', permission: 'write', role: 'pushes with plain git' },
  { user: 'live-bridge', fullName: 'Live Bridge', email: 'live-bridge@example.test', permission: 'admin', role: 'the editor service (repository admin: it manages its webhook)' },
];

const SEED_FILES = {
  'README.md': '# Handbook\n\nHow the team works. Edit any page here, in a browser or with git.\n\n- [Onboarding](docs/handbook/onboarding.md)\n- [Release checklist](docs/handbook/release-checklist.md)\n- [Retro notes](docs/notes/retro.md)\n',
  'docs/handbook/onboarding.md': '# Onboarding\n\n## First day\n\n- Get an account on the forge.\n- Read the release checklist.\n- Say hello in the team channel.\n\n## First week\n\n- Ship one small change.\n- Pair with someone on a review.\n',
  'docs/handbook/release-checklist.md': '# Release checklist\n\n1. All tests are green on main.\n2. The changelog has an entry.\n3. Tag the release.\n4. Announce it.\n',
  'docs/notes/retro.md': '# Retro notes\n\n## What went well\n\n- Fewer late reviews.\n\n## What to change\n\n- Write decisions down the same day.\n',
  'notes/scratch.md': '# Scratch\n\nAnything goes here.\n',
  'src/app.js': "console.log('not a markdown file');\n",
};

mkdirSync(HOME, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- ports and secrets

let ports = readJson('ports.json');
if (!ports) {
  const proxy = await freePort();
  const fj = await freePort([proxy]);
  const service = await freePort([proxy, fj]);
  ports = { proxy, forgejo: fj, service };
  writeJson('ports.json', ports);
}
const PUBLIC = `http://127.0.0.1:${ports.proxy}`;
const FORGEJO = `http://127.0.0.1:${ports.forgejo}`;
const SERVICE = `http://127.0.0.1:${ports.service}`;
const work = file('forgejo');

async function portOrDie(part) {
  if (await portFree(ports[part])) return;
  log.error(`port ${ports[part]} (${part}, recorded in ${file('ports.json')}) is in use by another process; this stack's addresses are fixed once Forgejo is set up. Free the port or use a new FORGEJO_LIVE_HOME.`);
  process.exit(1);
}

// ---------------------------------------------------------------- Forgejo

async function forgejoUp() {
  const ini = path.join(work, 'custom', 'conf', 'app.ini');
  if (!existsSync(ini)) {
    mkdirSync(path.dirname(ini), { recursive: true, mode: 0o700 });
    const secret = async (kind) => (await forgejo(['generate', 'secret', kind])).stdout.trim();
    // see the README, "How fast a push shows up": persistent queues are polled, in-memory ones are not
    const QUEUES = process.env.LIVE_FORGEJO_QUEUES === 'default' ? '; (Forgejo defaults: persistent queues)' : '[queue.push_update]\nTYPE = channel\n\n[queue.webhook_sender]\nTYPE = channel';
    const fill = { QUEUES, WORK: work, FORGEJO_PORT: ports.forgejo, PUBLIC_URL: PUBLIC, SECRET_KEY: await secret('SECRET_KEY'), INTERNAL_TOKEN: await secret('INTERNAL_TOKEN'), JWT_SECRET: await secret('JWT_SECRET') };
    writeFileSync(ini, readFileSync(path.join(ROOT, 'forgejo', 'app.ini.tmpl'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k]), { mode: 0o600 });
    log.info(`Forgejo configuration written to ${ini}`);
  }
  // the one template file of the integration; copied on every start so an edit here takes effect
  const tplDir = path.join(work, 'custom', 'templates', 'custom');
  mkdirSync(tplDir, { recursive: true });
  copyFileSync(path.join(ROOT, 'forgejo', 'custom', 'templates', 'custom', 'footer.tmpl'), path.join(tplDir, 'footer.tmpl'));

  if (await running('forgejo')) { log.info('Forgejo is already running'); return; }
  await portOrDie('forgejo');
  if (!existsSync(path.join(work, 'data', 'forgejo.db'))) await forgejo(['migrate']);
  const pid = start('forgejo', FORGEJO_BIN, ['--work-path', work, '--config', ini, 'web'], { marker: work, cwd: work });
  await waitFor(async () => (await fetch(`${FORGEJO}/api/healthz`)).ok, `Forgejo on ${FORGEJO} (log: ${file('logs', 'forgejo.log')})`, 90000);
  log.info(`Forgejo started (pid ${pid}) on ${FORGEJO}`);
}

async function seed() {
  if (readJson('accounts.json')) return;
  log.info('creating the synthetic accounts and the repository');
  const accounts = { repo: REPO, people: {}, oauth: null, webhookSecret: randomBytes(24).toString('hex') };
  for (const p of PEOPLE) {
    const password = `${p.user}-pass-${randomBytes(3).toString('hex')}`;
    await forgejo(['admin', 'user', 'create', '--username', p.user, '--password', password, '--email', p.email, '--fullname', p.fullName, '--must-change-password=false', ...(p.admin ? ['--admin'] : [])]);
    const as = { user: p.user, password };
    const scopes = p.admin ? ['all'] : ['write:repository', 'read:user'];
    const token = (await api(FORGEJO, 'POST', `/users/${p.user}/tokens`, { as, body: { name: 'prototype', scopes } })).json.sha1;
    accounts.people[p.user] = { user: p.user, password, email: p.email, fullName: p.fullName, role: p.role, token };
  }
  const root = { token: accounts.people.root.token };
  const [org, name] = REPO.split('/');
  await api(FORGEJO, 'POST', '/orgs', { as: root, body: { username: org, visibility: 'public' } });
  await api(FORGEJO, 'POST', `/orgs/${org}/repos`, { as: root, body: { name, private: false, default_branch: 'main', auto_init: false, description: 'Team handbook (synthetic data)' } });
  for (const p of PEOPLE) if (p.permission) await api(FORGEJO, 'PUT', `/repos/${REPO}/collaborators/${p.user}`, { as: root, body: { permission: p.permission } });

  const dir = mkdtempSync(file('seed-'));
  await git(dir, ['init', '--quiet', '-b', 'main']);
  for (const [name_, text] of Object.entries(SEED_FILES)) { mkdirSync(path.dirname(path.join(dir, name_)), { recursive: true }); writeFileSync(path.join(dir, name_), text); }
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.name=Root Admin', '-c', 'user.email=root@example.test', 'commit', '--quiet', '-m', 'Handbook: first pages']);
  await git(dir, ['push', '--quiet', `${FORGEJO}/${REPO}.git`, 'HEAD:refs/heads/main'], { as: accounts.people.root });

  // "Sign in with Forgejo" for the editor: an OAuth2 application owned by the administrator
  const app = (await api(FORGEJO, 'POST', '/user/applications/oauth2', { as: root, body: { name: 'Live editor', redirect_uris: [`${PUBLIC}/live/auth/callback`], confidential_client: true } })).json;
  accounts.oauth = { clientId: app.client_id, clientSecret: app.client_secret };
  writeJson('accounts.json', accounts);
}

// ---------------------------------------------------------------- service and proxy

const num = (name, fallback) => String(Number(process.env[name] ?? fallback));

async function serviceUp() {
  if (await running('service')) { log.info('the editor service is already running'); return; }
  await portOrDie('service');
  const a = readJson('accounts.json');
  const info = stackInfo();
  const state = file('service');
  const argv = [
    path.join(SERVICE_DIR, 'bin', 'serve.js'),
    // the synthetic repository and whatever scripts/import.mjs added
    '--forgejo', FORGEJO, ...[a.repo, ...(a.imported || []).map((r) => r.repo)].flatMap((r) => ['--repo', r]), '--public-url', PUBLIC, '--base-path', '/live',
    '--state', state, '--port', String(ports.service),
    '--bridge-name', a.people['live-bridge'].fullName, '--bridge-email', a.people['live-bridge'].email,
    '--debounce-ms', num('LIVE_DEBOUNCE_MS', 5000), '--max-wait-ms', num('LIVE_MAX_WAIT_MS', 60000), '--hold-ms', num('LIVE_HOLD_MS', 700),
    '--poll-ms', num('LIVE_POLL_MS', 15000), '--empty-ms', num('LIVE_EMPTY_MS', 30000),
    // LIVE_NO_REPO_DIR: the service as it would run on another machine than Forgejo (HTTP only)
    ...(process.env.LIVE_NO_REPO_DIR ? [] : ['--repos-root', path.dirname(path.dirname(info.repoDir))]),
    ...(process.env.LIVE_NO_DEMAND_FLUSH ? ['--no-demand-flush'] : []),
    ...(process.env.LIVE_NO_POKE_HOOK ? ['--no-poke-hook'] : []),
  ];
  const env = {
    LIVE_FORGEJO_BOT_USER: 'live-bridge',
    LIVE_FORGEJO_BOT_TOKEN: a.people['live-bridge'].token,
    LIVE_FORGEJO_OAUTH_CLIENT_ID: a.oauth.clientId,
    LIVE_FORGEJO_OAUTH_CLIENT_SECRET: a.oauth.clientSecret,
    LIVE_BRIDGE_WEBHOOK_SECRET: process.env.LIVE_NO_WEBHOOK ? '' : a.webhookSecret,
  };
  mkdirSync(file('logs'), { recursive: true });
  const pid = start('service', process.execPath, argv, { env, marker: state, cwd: SERVICE_DIR });
  await waitFor(async () => (await fetch(`${SERVICE}/live/api/status`)).ok, `the editor service on ${SERVICE} (log: ${file('logs', 'service.log')})`, 30000);
  log.info(`editor service started (pid ${pid}) on ${SERVICE}`);
}

async function proxyUp() {
  if (await running('proxy')) { log.info('the proxy is already running'); return; }
  await portOrDie('proxy');
  const pid = start('proxy', process.execPath, [path.join(ROOT, 'proxy', 'proxy.js'), '--port', String(ports.proxy), '--forgejo', FORGEJO, '--live', SERVICE, '--prefix', '/live', '--tag', HOME], { marker: HOME, cwd: ROOT });
  await waitFor(async () => (await fetch(`${PUBLIC}/live/api/auth`)).status < 500, `the proxy on ${PUBLIC} (log: ${file('logs', 'proxy.log')})`, 15000);
  log.info(`proxy started (pid ${pid}) on ${PUBLIC}`);
}

try {
  if (wanted('forgejo')) { await forgejoUp(); await seed(); }
  if (wanted('service')) await serviceUp();
  if (wanted('proxy')) await proxyUp();
} catch (e) {
  log.error(e.message);
  process.exit(1);
}

if (!quiet) {
  const a = readJson('accounts.json');
  const lines = [
    '',
    `Open:        ${PUBLIC}/${a.repo}/src/branch/main/docs/handbook/onboarding.md`,
    `             (sign in, then press "Edit live" in the file header)`,
    `Data folder: ${HOME}`,
    `Logs:        ${file('logs')}`,
    `Internal:    Forgejo ${FORGEJO}, editor service ${SERVICE} (people only use ${PUBLIC})`,
    '',
    'Accounts (synthetic):',
    ...Object.values(a.people).map((p) => `  ${p.user.padEnd(12)} password ${p.password.padEnd(26)} ${p.role}`),
    '',
    'An agent pushes with plain git, for example (credential.helper= keeps git from storing the',
    'synthetic token in a keychain or credential cache):',
    `  git clone -c credential.helper= http://agent:${a.people.agent.token}@127.0.0.1:${ports.proxy}/${a.repo}.git`,
    '',
    `Stop with:   FORGEJO_LIVE_HOME=${HOME} ${path.join(ROOT, 'scripts', 'down.sh')}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}
