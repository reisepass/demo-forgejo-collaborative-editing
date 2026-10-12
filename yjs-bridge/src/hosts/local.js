// A bare repository on local disk. Moves of main are noticed through a post-receive hook that
// pokes the service over HTTP (and by the bridge's polling).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GitHost } from './base.js';

const MARK = '# live-bridge hook';
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export class LocalHost extends GitHost {
  /**
   * @param {object} o
   * @param {string} o.dir the bare repository
   * @param {string} [o.owner] first URL segment, default "local"
   * @param {string} [o.repo] second URL segment, default the directory name without .git
   * @param {boolean} [o.hooks] install post-receive (default true)
   */
  constructor({ dir, owner = 'local', repo, hooks = true }) {
    const abs = path.resolve(dir);
    super({ kind: 'local', owner, repo: repo || path.basename(abs).replace(/\.git$/, ''), url: abs });
    this.dir = abs;
    this.hooks = hooks;
  }

  // The hook reads the service's current address from a file, so a restart on another port needs
  // no new hook. The service's own pushes (same machine, environment inherited) skip the poke.
  async watch({ stateDir, pokeUrl, branch = 'main', log }) {
    writeFileSync(path.join(stateDir, 'poke-url'), `${pokeUrl}\n`, { mode: 0o600 });
    if (!this.hooks) return [];
    const dir = path.join(this.dir, 'hooks');
    if (!existsSync(path.join(this.dir, 'HEAD')) || !existsSync(dir)) return [];
    const file = path.join(dir, 'post-receive');
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARK)) {
      log?.warn(`${file} exists and is not a bridge hook: left alone, relying on polling`);
      return [];
    }
    // LIVE_BRIDGE_HOOK_TRACE=<file> (diagnostics): the hook notes when it started and ended, to
    // tell a slow hook from a slow push
    const trace = process.env.LIVE_BRIDGE_HOOK_TRACE ? (what) => `echo "$(date +%s) $$ ${what} own=$LIVE_BRIDGE_OWN_PUSH" >> ${q(process.env.LIVE_BRIDGE_HOOK_TRACE)}\n` : () => '';
    writeFileSync(file, `#!/bin/sh
${MARK} (post-receive). Delete this file to remove it.
${trace('start')}[ -n "$LIVE_BRIDGE_OWN_PUSH" ] && exit 0
hit=0
while read old new ref; do [ "$ref" = ${q(`refs/heads/${branch}`)} ] && hit=1; done
[ $hit -eq 1 ] || exit 0
url=$(cat ${q(path.join(stateDir, 'poke-url'))} 2>/dev/null) || exit 0
${trace('before-curl')}curl -fsS -m 1 -X POST "$url" >/dev/null 2>&1
${trace('end')}exit 0
`, { mode: 0o755 });
    chmodSync(file, 0o755);
    return ['post-receive'];
  }
}
