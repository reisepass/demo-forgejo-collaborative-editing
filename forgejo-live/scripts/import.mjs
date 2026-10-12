#!/usr/bin/env node
// Copies one branch of an existing repository into the stack's Forgejo, as a private repository
// of an organisation, so there is real text to browse, search and edit live. One way only: the
// source is read with `git push <url>` from its own directory; no remote is saved there, nothing
// in it is changed, and nothing is ever pushed anywhere else.
//
//   node scripts/import.mjs <org>/<name> <source repository directory> [branch]
//
// ada and bob get push permission, the service's bot becomes repository admin (for its webhook).
// The editor service picks the repository up at its next start (scripts/up.sh does that).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { api, existsSync, file, git, log, readJson, stackInfo, writeJson } from './lib.mjs';

const [slug, source, branch = 'main'] = process.argv.slice(2);
const [org, name] = (slug || '').split('/');
if (!org || !name || !source || !existsSync(source)) { log.error('usage: import.mjs <org>/<name> <source repository directory> [branch]'); process.exit(2); }
const S = stackInfo();
if (!S) { log.error('the stack is not set up; run scripts/up.sh first'); process.exit(1); }
const a = S.accounts;
const root = { token: a.people.root.token };
const F = S.forgejoUrl;

try {
  // an organisation only its members and collaborators can see
  await api(F, 'POST', '/orgs', { as: root, body: { username: org, visibility: 'private' }, ok: [201, 422] });
  const made = await api(F, 'POST', `/orgs/${org}/repos`, { as: root, body: { name, private: true, default_branch: 'main', auto_init: false, description: `Copy of ${path.basename(path.resolve(source))} (${branch}), local only` }, ok: [201, 409] });
  if (made.status === 409) log.info(`${slug} exists already; pushing ${branch} again`);
  for (const [user, permission] of [['ada', 'write'], ['bob', 'write'], ['live-bridge', 'admin']]) await api(F, 'PUT', `/repos/${slug}/collaborators/${user}`, { as: root, body: { permission } });

  const src = path.resolve(source);
  const count = (pattern) => (pattern
    ? execFileSync('git', ['-C', src, 'ls-tree', '-r', '--name-only', branch], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter((l) => pattern.test(l)).length
    : Number(execFileSync('git', ['-C', src, 'rev-list', '--count', branch], { encoding: 'utf8' }).trim()));
  const t0 = Date.now();
  // --no-verify: the source's own pre-push hooks have no say in a local copy
  await git(src, ['push', '--quiet', '--no-verify', `${F}/${slug}.git`, `refs/heads/${branch}:refs/heads/main`], { as: a.people.root });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const dir = file('forgejo', 'repositories', org.toLowerCase(), `${name.toLowerCase()}.git`);
  const sizeMb = Math.round(Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]) / 102.4) / 10;
  const entry = { repo: slug, source: src, branch, importedAt: new Date().toISOString(), pushSeconds: seconds, sizeOnDiskMb: sizeMb, commits: count(null), files: count(/./), markdownFiles: count(/\.(md|markdown|mdx)$/i) };
  const accounts = readJson('accounts.json');
  accounts.imported = [...(accounts.imported || []).filter((r) => r.repo !== slug), entry];
  writeJson('accounts.json', accounts);
  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n${S.publicUrl}/${slug}\n`);
} catch (e) {
  log.error(e.message);
  process.exit(1);
}
