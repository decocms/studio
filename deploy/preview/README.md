# Per-PR preview environments

Label a pull request `preview` and you get a throwaway Studio at
`https://pr-<n>.preview.studio.decocms.com` — its own namespace, its own
database, its own bucket. Close the PR and all three are destroyed.

Previews exist because staging is a shared, post-merge resource: today the only
way to see a change running is to merge it. A preview lets a non-author — a
designer, a PM, another engineer — click a link instead of cloning the monorepo.

## Using one

1. Add the `preview` label to your PR.
2. Wait ~8–10 minutes for the image build, then ~1–2 more for the first sync
   (which creates and migrates the database). The bot comment updates itself.
3. Open the URL and sign up with any email and password. **The database is
   empty and yours.** It is deleted when the PR closes.

Access is gated at the Gateway on `decocms` GitHub org membership, so the link
is useless to anyone outside the org.

Remove the label to tear a preview down immediately. Previews also expire **48h
after their last deploy** — pushing to the PR, or re-adding the label, resets
the clock.

## What does not work, and why

| Not supported | Reason |
|---|---|
| Agent execution against a hosted sandbox | `STUDIO_SANDBOX_PROVIDER=user-desktop`, no daemon attached → `409 link_offline`. A hosted-sandbox preview class needs the `sandbox-env` chart and is out of scope. |
| AI features out of the box | No provider key is seeded, so preview LLM spend is zero by construction. Add your own key in org settings. |
| Google / GitHub sign-in | OAuth callbacks cannot be registered for a per-PR hostname. Email/password only. |
| Monitoring dashboard, billing, outbound email | No ClickHouse, no Stripe, no mail provider. |
| Multi-pod behaviour | A preview is one pod. Use `tests/multi-pod/` for anything about pod handoff, DBOS replay, or dispatch ownership. |

A preview proving something works is **not** evidence about any of the above.

## How it is wired

```
PR labelled `preview`
      │
      ├── .github/workflows/preview-build.yaml   (this repo)
      │     bun run build:studio → decocms.tgz
      │       ├── apps/api/Dockerfile → ghcr.io/…/studio-preview:pr-<n>-<sha7>
      │       └── apps/web/Dockerfile → ghcr.io/…/studio-nginx-preview:pr-<n>-<sha7>
      │     …then edits the sticky PR comment
      │
      └── ApplicationSet, PR generator      (decocms/deco-apps-cd)
            also gated on the `preview` label, polls every 60s
                  │
                  ▼
            Argo Application `studio-pr-<n>` → namespace `studio-pr-<n>`
                  │
                  ├── wave -30  ExternalSecret        (BETTER_AUTH_SECRET, ENCRYPTION_KEY, R2)
                  ├── wave -20  Postgres Deployment   (this preview's own database)
                  ├── wave -10  migrate Job           (migrate.js && migrate-dbos.js)
                  └── wave   0  Deployment + worker + NATS + Service + HTTPRoute

            Deleting the Application deletes the namespace, and the database
            goes with it — there is no teardown step to fail.

`.github/workflows/preview-ttl.yaml` (every 2h) removes the `preview` label from
PRs whose preview has not been redeployed in 48h, which makes the generator drop
the Application on its next poll.

It removes the **label**, not the Application: a directly-deleted Application is
regenerated within ~60s, because the generator's source of truth is the GitHub
API rather than the cluster. Age is measured from the sticky preview comment,
which the build workflow rewrites on every successful deploy — the PR's
`updatedAt` moves on any comment, and the head-commit date would instantly expire
a months-old PR someone labelled a minute ago to review. A preview whose comment
is missing is never reaped, on the same never-reap-on-ambiguity rule the image GC
follows.
```

Both halves check the label independently, so neither alone can create an
orphan. Nothing in this repo holds a cluster credential — the deploy side lives
entirely in the GitOps repo.

## Design decisions worth knowing

**Pod topology is identical to production.** It would be cheaper to skip the
nginx `-web` container and run one API container instead of two, and the chart
would need new values keys to allow it. We build the nginx image instead (~1
extra minute) because a preview running a different topology than prod is a
preview that can miss exactly the class of bug it exists to catch — the
asset-serving and `api-nginx.conf` proxy path is the thing being exercised.

**Migrations run in a Job, never in a pod.** The chart's default topology is
two API containers plus a worker, which is three processes that would race
`migrateToLatest` on a fresh database. Pods run with `--skip-migrations` and
the PreSync Job is the single writer; `validatePreview` fails the render if
that flag goes missing.

`--skip-migrations` alone is **not** sufficient. It only skips studio's own
migrations; DBOS still migrates its `dbos` schema on `DBOS.launch()`, and
parallel boots crash on `dbos.dbos_migrations` unique-constraint violations
(documented in `tests/multi-pod/docker-compose.yml`). That is what
`apps/api/src/database/migrate-dbos.ts` exists for, and why the Job runs both.

**A Postgres per preview, not a shared server.** Each preview runs its own
`postgres:16-alpine` pod on an emptyDir, created and destroyed with the
namespace.

The alternative — one shared server with per-PR `CREATE DATABASE` /
`DROP DATABASE` hook Jobs — needs a server provisioned and paid for while idle,
an admin credential distributed to every preview namespace, a connection budget
shared across previews, and a sweeper for databases that outlive their PR. A
pod per namespace has none of those, and it costs ~100m/256Mi.

It also means `DATABASE_URL` is not a credential: it addresses an ephemeral pod
reachable only from inside its own namespace, so the chart derives it and
publishes it in the ConfigMap. Bound cross-namespace reach with a NetworkPolicy,
not with a password.

**Empty database, not a golden template.** Cloning a pre-seeded golden database
with `CREATE DATABASE … TEMPLATE` is faster and lands the reviewer in a
populated org, but it needs a nightly rebuild job, a fixed shared
`ENCRYPTION_KEY`, and a fix for the origin baked into
`mcp_connections.connection_url` at write time (`apps/api/src/auth/org.ts`).
We took the simpler road; the cost is that you sign up first.

**One shared R2 bucket, not one per PR.** Object keys are scoped by org id, and
an empty-database preview generates fresh org UUIDs, so two previews can never
collide. (Bucket-per-PR would be mandatory if previews shared a seeded org id.)

**One wildcard certificate, terminated at the NLB.** Per-host certificates
would mean an issuance per PR and a handshake delay in front of the reviewer's
first click. An ACM wildcard on the load balancer matches how the sandbox
preview gateway and the studio NLB already work in this cluster.

**Ordering is expressed with sync-waves.** The ExternalSecret (-30) lands
before anything mounts it, Postgres (-20) before the migrate Job (-10) runs
against it, and the app Deployments (0) only after that Job completes. Argo
holds each wave until its resources report healthy — for a Job, that means
completed. A wrong wave surfaces as a CrashLoopBackOff on first sync rather
than a render error, so the ordering is asserted in CI.

## Configuration

`deploy/helm/studio/values-preview.yaml` holds the half of the configuration
that is identical for every preview. The per-PR half — image tags,
`preview.host`, `preview.prNumber`, `BASE_URL`, `BETTER_AUTH_URL`, `S3_BUCKET`,
`DATABASE_URL` — is injected by the ApplicationSet, which is the only thing
that knows the PR number.

CI renders `values-preview.yaml` on every `deploy/helm/**` PR
(`.github/workflows/helm-test.yml`) and asserts the properties previews depend
on, so the file cannot rot even though nothing in this repo deploys it.

### Cluster prerequisites (one-time, in `decocms/deco-apps-cd`)

- A wildcard `Gateway` for the preview domain, TLS terminated **at the NLB with
  an ACM cert** (not cert-manager) and published by external-dns — the same
  model as the sandbox preview gateway in `apps/studio-sandbox-stg/values.yaml`,
  which uses `tlsTermination: loadBalancer`. Give it a **different domain** from
  the sandbox gateway: two Gateways binding the same wildcard hostname conflict
  at the controller level.
- An oauth2-proxy / Istio `AuthorizationPolicy` on that listener.
- One shared **R2** bucket (`deco-studio-storage-preview`) with a lifecycle
  rule. Not a bucket per PR — see above.
- An AWS Secrets Manager entry at `preview/studio/application` holding
  `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` and the R2 credentials, reachable via a
  **ClusterSecretStore** (a namespaced SecretStore would need IRSA wired up per
  preview namespace). The first two must be **stable for the life of the
  environment**: a rotating `BETTER_AUTH_SECRET` is a login loop, and a rotating
  `ENCRYPTION_KEY` makes every vaulted credential undecryptable.
- No database server. Each preview brings its own.

## Troubleshooting

**The preview URL 404s or times out.** Almost always the namespace label. The
Gateway's `allowedRoutes.namespaces.from: Selector` matches on **namespace
labels**, and Argo's `CreateNamespace=true` does not label namespaces unless
`syncPolicy.managedNamespaceMetadata` sets them. Without the label the
HTTPRoute attaches to nothing and reports no error anywhere.

```sh
kubectl get ns studio-pr-<n> --show-labels        # want decocms.com/preview=true
kubectl -n studio-pr-<n> describe httproute       # check Accepted/ResolvedRefs
```

**Login fails with a CSRF-shaped error.** `BASE_URL` / `BETTER_AUTH_URL` do not
exactly match the host you loaded. `getTrustedOrigins()`
(`apps/api/src/auth/index.ts`) returns a single exact origin with no wildcard
support — scheme and host must match to the character.

**The app came up with an empty database that is not the one you provisioned.**
`externalUrlOrNull()` (`apps/api/src/settings/resolve-config.ts`) treats a
`DATABASE_URL` pointing at `localhost` / `127.0.0.1` / `::1` as "not external"
and the app self-provisions an embedded Postgres. Always use in-cluster service
DNS. The same trap applies to `NATS_URL` and `S3_ENDPOINT`.

**Pods CrashLoopBackOff on `dbos_migrations` unique-constraint violations.**
The PreSync migrate Job did not run, or did not get as far as
`migrate-dbos.js`. Check `kubectl -n studio-pr-<n> logs job/studio-pr-<n>-preview-migrate`.

**A preview's data vanished after a restart.** Expected. The Postgres pod uses
an emptyDir, so a reschedule starts from an empty database; the migrate Job
re-runs on the next sync, but anything you created in the UI is gone. Previews
are throwaway by construction — if you need durability, you want a real
environment.

**Databases outliving their PR.** Not possible: the database is a pod in the
namespace Argo deletes. This is the main thing the per-preview Postgres buys
over a shared server.
