# Automatic upstream deployment

Upstream updates are split across two runners:

1. `.github/workflows/upstream-sync.yml` checks upstream every 15 minutes,
   merges it onto the personal `main` branch, and runs tests, type checking,
   and a production build. This job has no Cloudflare credential. Checkout uses
   `persist-credentials: false`.
2. `.github/workflows/upstream-deploy.yml` starts after a successful sync. It
   downloads the prebuilt artifact and validates it against trusted policy on
   a new runner. Only a pinned `cf` uploader receives the Cloudflare token.
   Candidate dependencies, scripts, and configuration are never executed with
   that token.

`main` is advanced only after a release succeeds. A failed release is retried
once only when the live Worker version is still unchanged. If the live version
changed during a failed release, automation stops for manual reconciliation.
There is no automatic rollback.

## Gates

Automatic deployment stops before merge or deploy when an update changes:

- GitHub workflows, trusted sync code, or this document.
- Package manifests, lockfiles, dependency tooling, or stateful SDK versions.
- Cloudflare deployment configuration, secrets, bindings, Durable Object
  exports, compatibility settings, routes, triggers, or preview policy.
- Authentication, security guards, secret handling, MCP OAuth, hook routes,
  or deployment upload code.
- Migration directories or schema/storage initialization in agent source,
  including inline SQL and Durable Object storage calls.

The artifact validator also checks the account ID, Worker name, exact binding
map, secret binding names, exports, production build mode, routes, triggers,
preview policy, file types, and content digests.

Personal invariants checked after merge:

- `google_client` is never dropped.
- The email routing token remains conditional.
- `dynamic/command-code` remains registered.
- PWA manifest serving remains present.
- The forbidden `experimental` compatibility flag is absent.

## One-time setup

The user must perform these steps; the repository intentionally contains no
credentials.

1. Set the fork's default branch to integrated `main`, or make `main` contain
   this automation before enabling the schedule.
2. Create and watch one GitHub issue for deployment reports.
3. Add repository variables:

   - `COWORKERS_ACCOUNT_ID`
   - `COWORKERS_ACCESS_TEAM_DOMAIN`
   - `COWORKERS_ACCESS_AUD`
   - `COWORKERS_UPDATE_ISSUE_NUMBER`

4. Add repository secret `CLOUDFLARE_API_TOKEN`. Use a dedicated token scoped
   to the personal account with the minimum Worker deployment permissions.
   Do not reuse a broad account token.
5. Confirm `.github/upstream-sync/deployment-state.json` matches the live
   Worker version before the first run. A mismatch fails closed.
6. Add a GitHub environment named `coworkers-production`. Environment
   protection rules are optional but recommended for the initial bootstrap.
7. Run `Upstream sync candidate` manually, inspect the artifact and CI result,
   then run `Upstream deploy` with that successful run ID.

Do not add `.dev.vars.production` to GitHub. Existing Worker secrets are left
unchanged because prebuilt deploys do not pass a secrets file. A newly
declared secret or binding is rejected by the artifact gate and requires a
manual reviewed change to trusted automation.

## Retry and state

The deployment state records the last successfully deployed Worker version,
upstream SHA, candidate SHA, and time. Before deploying, the trusted job reads
the live deployment and refuses to continue if another deployment changed the
baseline.

If `cf deploy` fails while live remains unchanged, it retries once. If live may
have changed, it stops without retrying. Re-run the deploy workflow with the
retained sync run ID only when the failure report confirms the release never
became live.

The `manifest.webmanifest` and `sw.js` checks are smoke signals only. They do
not prove signed-in chat, WebSocket, Durable Object, MCP, or tool behavior.
