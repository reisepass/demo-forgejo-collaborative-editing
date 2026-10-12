# Live editing inside Forgejo, without a fork

A person browsing a markdown file in Forgejo's own web interface presses "Edit live", edits it
together with others in real time, and the text lands as git commits in that Forgejo repository
under the name of who typed it. Pushes by coding agents (plain git) show up in the open editor
without a reload. Forgejo itself is unmodified: one template line, one OAuth2 application, one
webhook, one reverse-proxy route.

The editor, the rooms and the git bridge are the service in `../yjs-bridge`. This
folder holds what is specific to Forgejo and is not service code: configuration, the template
line, the proxy, start and stop scripts, and end-to-end tests against real Forgejo pages.

Run on: Forgejo 16.0.5, built from the release source tarball for macOS arm64 (the project
publishes Linux binaries only), SQLite, no Docker.

## Layout

| Path | What |
| --- | --- |
| `forgejo/app.ini.tmpl` | Forgejo configuration; the lines the integration needs are marked `LIVE` |
| `forgejo/custom/templates/custom/footer.tmpl` | the whole change on Forgejo's side: one `<script>` line |
| `proxy/proxy.js` | the one origin: `/live/` (and its websocket) to the service, everything else to Forgejo |
| `scripts/up.sh`, `scripts/down.sh` | start and stop Forgejo, the service and the proxy (`up.mjs`, `down.mjs`, `lib.mjs`) |
| `e2e/` | Playwright tests, headless, against the real Forgejo pages |
| `../yjs-bridge/src/hosts/forgejo.js` | host adapter: read, push as the person, webhook, hooks |
| `../yjs-bridge/src/auth-forgejo.js` | "Sign in with Forgejo" behind the service's sign-in interface |
| `../yjs-bridge/web/embed.js` | the script Forgejo's pages load: button and in-place mount |

## Run it

```sh
export FORGEJO_BIN=/path/to/forgejo            # a Forgejo binary for this machine
export FORGEJO_LIVE_HOME=/path/to/empty/folder # all data, logs and pids go here
scripts/up.sh      # prints the URL to open and the accounts
scripts/down.sh    # stops exactly the processes up.sh started (recorded pids)
```

`up.sh` starts from an empty folder (configuration, database, accounts, repository, OAuth2
application) and reuses the folder on later runs. Ports are picked free on the first run and then
kept (`ports.json`), because Forgejo's `ROOT_URL` and the OAuth2 redirect address contain them.
`--only forgejo|service|proxy` starts or stops one part.

Synthetic accounts (passwords are generated and printed): `root` (site administrator), `ada` and
`bob` (may push), `carol` (read only), `agent` (pushes with plain git), `live-bridge` (the
service's bot). Repository: `acme/handbook`, public, markdown files in folders.

## Real repositories and code search

```sh
node scripts/import.mjs <org>/<name> /path/to/a/repository [branch]   # needs the stack running
scripts/down.sh --only service && scripts/up.sh                       # the service picks it up
```

`import.mjs` copies one branch into a private repository of a private organisation (ada and bob
may push, the bot is admin) with `git push <url>` run from the source directory: no remote is
saved there, nothing in the source changes, nothing is pushed anywhere else. The service then
serves every imported repository next to the synthetic one (`--repo` may be given several
times, `--repos-root` is Forgejo's repository folder).

Forgejo's built-in code search is switched on in `app.ini.tmpl` (`[indexer]
REPO_INDEXER_ENABLED = true`, bleve). Search a repository at `/<org>/<name>/search?q=...`.
`e2e/6-imported.spec.js` types one marker line into a real markdown file of an imported
repository and, with `E2E_SEARCH="word|a phrase"`, prints what the search returns; it is skipped
on a stack without imported repositories.

## How it is put together

```
browser ──> proxy :P ──┬── /live/*, /live/ws ──> editor service :S ──┐ git over HTTP, API, OAuth2
                       └── everything else ───> Forgejo :F <─────────┘
                                                   │  webhook (push, signed)        ┌─> service
                                                   └─ hooks/post-receive.d, pre-receive.d ─┘
```

1. **Entry point.** `custom/templates/custom/footer.tmpl` loads `/live/embed.js` on every page.
   On the page of a markdown or text file on `main` of a served repository the script adds an
   "Edit live" button to the file header. No built-in template is overridden.
2. **One origin.** People only use the proxy's address, which is Forgejo's `ROOT_URL`.
   - *In place* (what the button does): the editor is mounted where the rendered file was;
     Forgejo's header, repository tabs, breadcrumb and file header stay. URL: the file's URL with
     `?live=1` (Forgejo ignores the parameter, the script sees it), so reload, bookmark and the
     back button work.
   - *Full page*: `/live/r/<owner>/<repo>/edit/<path>`, the same editor as a page of its own.
     It keeps working while Forgejo is down.
3. **Sign-in and permissions.** The service sends the browser through Forgejo's OAuth2 provider
   (authorization code, scopes `read:user write:repository`) and afterwards holds a session
   cookie (HttpOnly, SameSite=Lax); Forgejo tokens never reach the browser. What a person may do
   is asked from Forgejo with that person's token (`permissions.push` / `permissions.pull` of the
   repository): push permission edits, read permission watches live in a view-only editor
   (updates they send are dropped by the service), no access is refused, no session is sent to
   Forgejo's sign-in. Requests that change something, and websockets, are only accepted from the
   site's own origin.
4. **Writing.** Every commit is pushed through Forgejo over HTTP, never written into the
   repository on disk, and it is pushed *as the person who typed it* (their OAuth2 token as the
   git credential). Forgejo therefore applies that person's permissions and branch protection at
   the moment of the push, runs its hooks, updates its database, shows the person as pusher in
   the activity feed and fires webhooks, exactly as for a push from their own machine. The bot
   account only reads, manages the webhook, and pushes a commit when its author has no usable
   sign-in any more.
5. **Agent pushes.** Three ways the service learns that `main` moved, all active by default:
   a post-receive hook file (fastest), the signed webhook, and slow polling as the fallback.
6. **Demand flush.** A pre-receive hook file asks the service before somebody else's push to
   `main` lands. If the push touches a file with typed text that is not on `main` yet, that text
   is committed first and the push is turned away once; the agent sees an ordinary rejected push
   (`pre-receive hook declined`, with a message naming the person and the commit) and rebases.

## What the administrator configures

1. A reverse proxy that sends `/live/` (with websocket upgrade) to the service and the rest to
   Forgejo; Forgejo's `ROOT_URL` is that public address. nginx:
   ```nginx
   location /live/ { proxy_pass http://127.0.0.1:<service>; proxy_http_version 1.1;
                     proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
                     proxy_set_header Host $host; }
   location /live/internal/ { return 404; }  location /live/api/status { return 404; }
   location / { proxy_pass http://127.0.0.1:<forgejo>; proxy_set_header Host $host; }
   ```
2. `custom/templates/custom/footer.tmpl` with the one line from this folder, then a Forgejo
   restart (templates are read at start).
3. An OAuth2 application in Forgejo (confidential, redirect URI `<ROOT_URL>live/auth/callback`);
   its client id and secret go to the service. Each person confirms it once on first use.
4. A bot account with an access token (`write:repository`), collaborator with admin permission
   on each served repository (admin only so the service can create its own webhook; with write
   permission the webhook has to be created by hand).
5. `[webhook] ALLOWED_HOST_LIST` must include the service's address (`loopback` here; Forgejo's
   default `external` refuses 127.0.0.1 and private networks).
6. Optional, when the service runs on the machine that holds the repositories: `--repo-dir`.
   The service then puts two hook files into the repository (`hooks/post-receive.d/live-bridge`,
   `hooks/pre-receive.d/live-bridge`) and reads from the directory. `DISABLE_GIT_HOOKS` stays at
   its default (`true`): these are files placed by the administrator's own service, not hooks
   edited through the web interface.
7. Optional, for a fast webhook without hooks: `[queue.push_update] TYPE = channel` and
   `[queue.webhook_sender] TYPE = channel` (see below).

## How fast a push shows up

Measured by `e2e/2-agent.spec.js` on this machine (Apple silicon, everything on localhost): from
the moment `git push` returned on the agent's side to the moment the text is in the open editor,
25 pushes per row.

| How the service learns of the push | Median | p95 | Max | Rerun with |
| --- | --- | --- | --- | --- |
| hook files + webhook, reads from the repository directory (default of `up.sh`) | 60 ms, 80 ms | 128 ms, 88 ms | 133 ms, 92 ms | `npx playwright test 2-agent` (two runs) |
| webhook only, in-memory queues, everything over HTTP | 549 ms | 641 ms | 654 ms | `LIVE_NO_REPO_DIR=1 npx playwright test 2-agent` |
| webhook only, Forgejo's default queues, everything over HTTP | 1185 ms | 2853 ms | 2960 ms | `LIVE_NO_REPO_DIR=1 LIVE_FORGEJO_QUEUES=default npx playwright test 2-agent` |
| polling only, every 3 s | at most the interval | | | `LIVE_NO_REPO_DIR=1 LIVE_NO_WEBHOOK=1 LIVE_POLL_MS=3000 npx playwright test 2-agent` |

(The polling row passes, which is its point: the fallback alone delivers every push. Its timing
is not given because the test's push rhythm locks onto the polling rhythm.)

Why the settings matter:

- Forgejo hands a push to the webhook through two queues (`push_update`, then `webhook_sender`).
  The default persistent queues are polled with a back-off that grows to 2 s while idle, so the
  webhook leaves up to about 4 s after the push returned. In-memory queues (`TYPE = channel`)
  hand over at once; their price is that entries waiting in them are lost if Forgejo is killed
  (the editor is covered by polling, other consumers of those queues are not).
- A fetch over HTTP is three requests, and on each Forgejo spends about 70 ms checking the bot's
  access token. Reading from the repository's directory takes that out.
- The post-receive hook file runs inside the push itself, so the service has usually fetched and
  merged by the time `git push` returns.

On macOS, start the stack with `scripts/up.sh` (as the tests do), not by hand: `/usr/bin/git` is
a launcher that can take 80 ms per call depending on the caller's `PATH`, and `scripts/lib.mjs`
puts the real git first for the processes it starts.

## Tests

```sh
export FORGEJO_BIN=/path/to/forgejo
export E2E_SCRATCH=/path/to/scratch   # each run makes a new folder run-<UTC time> in here
npx playwright test                   # all specs; starts and stops its own stack
E2E_KEEP=1 npx playwright test 1-edit # leave the stack running afterwards (stop: scripts/down.sh with that folder)
```

| Spec | What it proves |
| --- | --- |
| `1-edit.spec.js` | sign-in through Forgejo's form, browse to a file, the injected button, real keystrokes, the commit under ada's name in Forgejo's API, history page and activity feed; bob joins, both see names, carets and text, one commit with a co-author; every view has its own URL (reload, back, forward, full page) |
| `2-agent.spec.js` | 25 agent pushes appear without a reload; median and p95 are printed and written to `latency.json` |
| `3-clash.spec.js` | with the hook: push rejected once, ada's text committed under her name, agent rebases, both on main, no conflict branch; without: banner, conflict branch pushed as ada and shown by Forgejo |
| `4-permissions.spec.js` | carol watches but cannot write (editor, forged update, API, git); anonymous is sent to Forgejo's sign-in and comes back to the editor; a cookie from another origin opens no websocket; operator endpoints are not on the public address |
| `5-restart.spec.js` | `kill -9` of the service and a stop of Forgejo with an editor open: nothing typed is lost, no reload |
| `6-imported.spec.js` | on a stack with imported repositories only: a marker line in a real markdown file becomes a commit under ada's name; the private repository is hidden from anonymous visitors; code search queries |

## What an upgrade of Forgejo can break

Stable interfaces, expected to survive: the `custom/footer` injection point, the OAuth2 provider,
the API calls used (`/user`, `/repos/{owner}/{repo}`, `/repos/{owner}/{repo}/hooks`), git over
HTTP with a token, the webhook and its `X-Forgejo-Signature` header, and custom hook files in
`hooks/<name>.d/`.

Fragile, because it reads Forgejo's page instead of an interface (`../yjs-bridge/web/embed.js`):
the URL shape `/<owner>/<repo>/src/branch/<branch>/<path>`, the element `.file-view` (replaced by
the editor), `.file-header .file-actions` (where the button goes), the button's classes
`ui mini primary button`, and `window.config.appSubUrl`. If one of them changes the button does
not appear; nothing else breaks, and the full-page editor under `/live/r/` does not depend on
any of them.

## Known limits

- Branch `main` only. Several repositories are served by one process, each named at start.
- Permissions are asked when an editor connects and cached for 10 s. Someone who loses push
  permission while connected keeps typing into the room, but their commits are pushed with their
  own token, so Forgejo refuses them and the editor shows why; the text is not on `main`.
- A commit is pushed with the token of its first author. Text of several people in one commit is
  let in on the first author's permission (all of them had push permission when they connected).
- If `main` is protected so that nobody may push directly, live editing cannot save: the editor
  says so and keeps the text. Working through pull requests is not built.
- The view-only editor of a reader keeps a session open like any editor does.
- Each person sees Forgejo's "Authorize application" page once. Forgejo has no setting to skip
  it for an administrator's own application.
- While Forgejo is down the in-place view cannot be reloaded (its page is Forgejo's); the
  full-page URL can.
- "Edit live" is offered on `main` of served repositories only; file pages on other branches and
  the read-me shown on the repository's front page have no button.
- Git over SSH is switched off in this stack (`DISABLE_SSH`); agents push over HTTP. Hooks and
  webhook do not depend on the transport.
