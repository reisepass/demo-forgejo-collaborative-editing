# What the owner has to create on GitHub

The demo runs without any of this: it reads and writes over SSH with the key the machine
already has, watches `main` by polling, and signs people in with a development form. Two things
are stubbed behind interfaces and need something created on GitHub by the repository owner.

## 1. Minimum: a repository webhook (no app)

Enough to replace polling with push notifications. Repository -> Settings -> Webhooks -> Add webhook.

| Field | Value |
| --- | --- |
| Payload URL | `https://<service-host>/webhook/github` |
| Content type | `application/json` |
| Secret | a random string; the same value goes into the service's environment as `LIVE_BRIDGE_WEBHOOK_SECRET` |
| SSL verification | enabled |
| Which events | "Just the push event" |
| Active | yes |

The service verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the secret, constant
time comparison), answers `ping`, ignores pushes to other branches and branch deletions, and on a
push to `main` fetches once. Polling stays on as a fallback (a missed delivery costs one poll
interval, nothing else).

Writing then still needs a credential on the service's machine: a deploy key with write access
(Settings -> Deploy keys -> Add deploy key, "Allow write access"), used through the normal SSH
setup.

## 2. Real target: a GitHub App

One app covers sign-in, the push permission check, the webhook and the writes.

### Registration (Settings -> Developer settings -> GitHub Apps -> New GitHub App)

| Field | Value |
| --- | --- |
| GitHub App name | free choice, for example `live-markdown-bridge` |
| Homepage URL | `https://<service-host>/` |
| Callback URL | `https://<service-host>/auth/github/callback` |
| Expire user authorization tokens | on |
| Request user authorization (OAuth) during installation | off (people sign in from the editor) |
| Enable Device Flow | off |
| Setup URL | empty |
| Webhook: Active | on |
| Webhook URL | `https://<service-host>/webhook/github` |
| Webhook secret | random string, also given to the service as `LIVE_BRIDGE_WEBHOOK_SECRET` |
| Where can this GitHub App be installed | "Only on this account" |

### Permissions

| Scope | Permission | Access | Why |
| --- | --- | --- | --- |
| Repository | Contents | Read and write | fetch `main`, push live-edit commits to `main`, push `conflict/...` branches |
| Repository | Metadata | Read-only | mandatory; also answers "may this user push" |
| Account | Email addresses | Read-only | the email put into the author field (optional: the service can use the `ID+login@users.noreply.github.com` address instead and then needs no account permission) |

Nothing else: no Administration, Actions, Workflows, Secrets, Pages, Pull requests or Issues.

### Events to subscribe to

- `Push`

(`installation` and `installation_repositories` are delivered to every app without subscribing;
the service can ignore them or use them to learn which repositories it serves.)

### After creating it

1. Generate a private key (PEM) and note the App ID and the Client ID; generate a client secret.
2. Install the app on the account, "Only select repositories", and pick the repositories to edit.
3. Give the service: App ID, private key file, Client ID, client secret, webhook secret.

### What the service does with it (not implemented yet, one class each)

- **Sign-in** (`src/auth.js`, same interface as `DevAuth`): OAuth web flow with the app's client
  ID: `GET https://github.com/login/oauth/authorize?client_id=...&redirect_uri=<callback>&state=...`,
  then `POST https://github.com/login/oauth/access_token` with the code. Name and email from
  `GET /user` and `GET /user/emails`.
- **Push permission** (`canWrite`): `GET /repos/{owner}/{repo}` with the user's token and read
  `permissions.push`; or, with the installation token,
  `GET /repos/{owner}/{repo}/collaborators/{username}/permission`. Checked when a room is joined
  and again before a commit is authored in that person's name.
- **Writing** (`src/hosts/github.js`, `fetch`/`push` of the adapter): an installation access token
  (`POST /app/installations/{installation_id}/access_tokens`, valid one hour, limited to
  `contents: write` on the one repository) used as the HTTPS git credential
  (`https://x-access-token:<token>@github.com/<owner>/<repo>.git`). Pushes stay ordinary,
  non-forced pushes, so the compare-and-swap on `main` is unchanged. Commits then show the app as
  the pusher; author stays the person who typed, committer the bridge identity
  (for example `<app-slug>[bot] <<bot-user-id>+<app-slug>[bot]@users.noreply.github.com>`).
- **Webhook**: already implemented and tested with locally signed deliveries; with the app the
  payload has the same shape plus an `installation` object.

### If `main` is protected

A branch protection or ruleset that requires pull requests would reject the service's pushes. The
app has to be on the bypass list of that rule, or live editing has to target a branch that is not
protected. Rules that only forbid force pushes and deletions are fine and recommended: the service
never does either.
