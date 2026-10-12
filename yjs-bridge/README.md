# The editor service: live markdown editing over git

People edit git-tracked markdown files together in a browser, live, with cursors and names. Every
other writer keeps using plain git and knows nothing about this service. `main` is the only
durable truth and only moves forward.

One Node process does everything: it serves the editor, holds the rooms (one Yjs document per
repository and path) on a websocket, and is the bridge to git. Because it holds the document in
memory it reads and writes the live text directly.

## Layout

| Path | What |
| --- | --- |
| `bin/serve.js` | starts the service for one repository |
| `src/bridge.js` | rooms, fold (git to people), flush (people to git), hold, conflict branches, sessions, recovery |
| `src/server.js` | HTTP (editor, API, webhook, hook poke) and the room websocket |
| `src/hosts/base.js`, `local.js`, `github.js`, `forgejo.js` | host adapter interface and its implementations |
| `src/auth.js`, `src/auth-forgejo.js` | sign-in interface, the development implementation, and "Sign in with Forgejo" |
| `src/roomlog.js` | durable room state: append-only log of Yjs updates and room meta data |
| `src/text.js` | line ending handling, minimal edits |
| `src/client/live.js`, `protocol.js` | the editor's connection, shared by the browser and the tests |
| `src/shared/merge.js` | three-way merge with a word-level second pass |
| `web/` | the editor: CodeMirror 6 on a `Y.Text`, built with esbuild into `dist/`; `web/embed.js` mounts it inside a git host's own file page |
| `test/`, `e2e/` | tests without a browser (node:test) and with one (Playwright) |
| `docs/GITHUB_APP.md` | what the repository owner has to create on GitHub |

## Run it

```sh
pnpm install
node web/build.js
# a bare repository on disk
node bin/serve.js --local /path/to/repo.git --state /path/outside/any/repo/state --port 4477
# a repository on GitHub (git over SSH with this machine's key, polling)
node bin/serve.js --github <owner>/<repo> --state /path/outside/any/repo/state --port 4477
# a repository on a Forgejo instance, behind the same reverse proxy as Forgejo (see ../forgejo-live)
node bin/serve.js --forgejo http://127.0.0.1:<forgejo port> --repo <owner>/<repo> \
  --public-url https://forge.example --base-path /live --state /path/outside/any/repo/state --port 4477
```

With `--forgejo` people sign in through Forgejo (OAuth2), commits are pushed through Forgejo as
the person who typed them, someone with read permission watches in a view-only editor, and the
service's routes live under the base path so it shares Forgejo's origin. Everything about that
setup, including its start script and tests, is in `../forgejo-live/README.md`.

Open `http://127.0.0.1:4477/`. Sign in with a name and an email address (development sign-in),
pick a file. URLs: `/r/<owner>/<repo>` is the file tree, `/r/<owner>/<repo>/edit/<path>` the
editor.

Options: `--debounce-ms` (5000), `--max-wait-ms` (60000), `--hold-ms` (700), `--poll-ms`,
`--empty-ms` (30000), `--join-grace-ms` (30000), `--idle-ms` (1800000), `--no-hooks`.
`LIVE_BRIDGE_WEBHOOK_SECRET` in the environment turns on `POST /webhook/github`.

## How it behaves

- **People to git.** After a typing pause, at the latest after max-wait, and when a session ends,
  the live text is committed on top of `main` and pushed without force. A rejected push means
  `main` moved: fetch, fold, build the commit again. Author is the first person who typed since
  the last commit, further typists are `Co-authored-by`, the committer is the bridge. Who typed is
  taken from the signed-in connection that delivered each Yjs update. Messages hold line counts
  only.
- **Git to people.** When `main` moves and touches an open file: three-way merge (base, live,
  main), word by word where both changed a line, applied to the `Y.Text` as the smallest edits in
  one transaction. Editors show "Changed by ... in <commit>" without a reload.
- **Clash.** `main` keeps its lines, the editor takes them, the complete text from before the merge
  goes to `conflict/<user>/<path>-<UTC time>` (parent: the room's base). The swap waits until
  nobody has typed for `--hold-ms`. A banner names the author, the commit and the branch in full.
- **Bytes.** The shared text has LF line breaks; a commit lays the edited lines over the raw base
  text, so untouched lines keep their line endings, and a file without a final newline stays so.
- **Sessions.** A room's document outlives its sessions. A session ends when everyone left
  (`--empty-ms`) or nobody typed for `--idle-ms`; the text is flushed and the room stored as one
  snapshot. An ended session is shown as ended in open editors; typing starts a new one.
- **Crash.** Every Yjs update is in the room log before it is confirmed to the editor. After
  `kill -9` the rooms are recovered, a push that may have been in flight is settled, and editors
  reconnect by themselves and hand over what was typed meanwhile.
- **Service down.** Git is unaffected.

## Tests

`BRIDGE_SCRATCH=<dir>` says where the test repositories, state and logs go (default: the system
temp directory).

```sh
node --test --test-concurrency=1 test/core.test.js     # 23 scenarios, no browser
node --test test/crash.test.js                         # kill -9: 20 random moments, the room log alone, 3 exact moments
npx playwright test                                    # 9 browser tests, headless Chromium (one of them: 20 kills)
node test/loadtime.js                                  # load time, cold and warm, 2 kB and 500 kB
SOAK_ROUNDS=100 SOAK_MIN_MS=2000 SOAK_MAX_MS=8000 node test/soak.js          # 200 agent rounds
BRIDGE_REMOTE=git@github.com:<owner>/<repo>.git node --test --test-concurrency=1 test/github.test.js
SOAK_REMOTE=git@github.com:<owner>/<repo>.git SOAK_ROUNDS=30 node test/soak.js
```

## Known limits

- Without `--forgejo`, sign-in is a development form: anyone who reaches the service may write.
  The interface is in `src/auth.js`; a real implementation exists for Forgejo
  (`src/auth-forgejo.js`), what one needs on GitHub is in `docs/GITHUB_APP.md`.
- `GET /api/status` is open to whoever reaches the port (paths, names, commit hashes, no text).
  The service listens on 127.0.0.1 by default.
- A webhook from GitHub cannot reach a laptop. The endpoint is tested with deliveries built and
  signed locally; against GitHub the service polls.
- While a clash is held back for a typing pause, the other changes of that commit and later
  commits to the same file wait with it (measured: median 2 s, up to max-wait): a fold always goes
  to the tip of `main`. Holding back only the clashing lines needs a base text that is not a commit.
- Against GitHub with polling about a third of the service's pushes are rejected once because an
  agent's commit landed since the last fetch; every rejection costs one more fetch and push (about
  1.6 s). A delivered webhook, or a fetch during the typing pause, would shrink that window.
- Two people typing at the very same position at the same moment can end up with their characters
  interleaved. That is the CRDT's ordering, nothing is lost.
- A room document keeps the history Yjs needs to merge late editors and is never rebuilt. If the
  file is removed on `main` and comes back, it gets a new document; a tab that still holds the old
  one saves its unconfirmed text to a conflict branch and starts over.
- A file with mixed line endings keeps them, but a client that is not CodeMirror could put a
  carriage return into the shared text; nothing filters that.
- One process, one machine: rooms live in memory, there is no second instance to take over.
