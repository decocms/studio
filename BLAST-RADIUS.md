# 100x — deploy velocity and blast radius

**Status:** proposal, for engineering review · **Branch:** `gui/blast-radius` · **Date:** 2026-09-18

> The ask: ship 100x/day with a small blast radius. This doc separates what is
> actually slow from what merely *feels* slow, proposes an architecture, and
> names the features we should delete while we are in there.

---

## 0. Measure first — what is actually slow

Numbers from this repo and our own telemetry, not vibes.

| Thing | Reality |
|---|---|
| Unit tests (`test.yml`) | 1–7 min |
| E2E (`e2e.yml`, Playwright) | 4–7 min |
| `release-studio.yaml` (dist → npm → docker×2 multi-arch → manifests) | **6–16 min** |
| Releases actually cut | **~12–15/day** (Sept 17: 12 runs) |
| Deploys to **staging** | automatic, on every release |
| Deploys to **production** | **a human clicks Sync in ArgoCD** |
| Active app users (30d) | **215** |
| Active orgs (30d) | **154** |
| Revenue-critical operated accounts | 5 (Osklen, Monte Carlo, Farm, Fila, Sprint) |

**CI is not the bottleneck.** We already merge and release a dozen times a day.
The bottleneck is everything after the artifact exists:

1. **Prod promotion is a manual click in a foreign UI.** `release-studio.yaml`
   fires a `studio-image-bump` dispatch at `decocms/deco-apps-cd`, which bumps
   `deco-studio-stg` (auto-sync) and `deco-studio` (**manual-sync** — "the prod
   promotion gate is preserved"). Nobody wants to click it, so batches grow, so
   each click is scarier, so people click less. Classic.
2. **Every rollout is 100% of traffic.** No canary, no weighted rollout, no
   automated rollback. One Deployment, one Service, all 154 orgs at once.
3. **Migrations block the whole sync.** `migrate-job.yaml` is an Argo Sync hook
   at wave `-10`. Our own chart comments document that when it hangs, "Argo
   blocks the whole operation waiting for it — and a blocked operation cannot be
   superseded." 232 migrations on one Postgres, shared by every feature.
4. **One artifact, one fault domain.** `apps/api` (276k LOC, 176 tools, 96 route
   files) + `apps/web` (320k LOC, 131 route files) ship as one image pair. A
   change to the report slide templates redeploys auth.

The fear is rational. The fix is to make a bad deploy cheap, not to make deploys
rare.

---

## 1. What we are building (so the architecture serves it)

From `context/03_product/product-vision.md` + `product-overview.md`:

- deco is an **AI-native agency**; **Studio is the open-source engine** it runs on.
- The engine loop is **signals → objectives → tasks**. Tasks are real today;
  signals are partial; objectives are not built.
- The product doctrine already states the answer to this doc:
  **"new internal needs are solved as an MCP app on top, not as new core features."**
  We follow it in exactly one place — **Reports** (see §2.0) — and nowhere else.
  Jira, hosting, registry, task-board, library, site-editor and monitoring all
  landed *inside* `apps/api`.
- The agent primitive is decided: **one Super Agent, many skins**, plus **apps**
  that own a surface. `project-app-view.tsx` + the `mcp_app_opened` event
  (3.4k events / 137 users in 30d) prove the extension point already works.

So the architecture below is not a new idea. It is the product's own stated model,
applied to the deployment topology.

---

## 2. The proposal

### 2.0 We already did this once — Reports

Reports is **not** in Studio. The engine lives in `decocms/reports` (separate
private repo, TypeScript, actively developed). What Studio carries is a binding:

| Piece | Where | Size |
|---|---|---|
| Diagnostic engine, its data, its `/api/v2` | **`decocms/reports`** | separate deploy |
| 5 MCP tools (`REPORTS_BIND/RUN/SETUP/SET_REPOSITORY/CONNECTION_STATUS`) that HTTP out to it | `apps/api/src/tools/reports/` | 2,460 LOC |
| Server-side proxy `/api/_reports/*` + share routes + page render | `apps/api/src/api/routes/` | 4 files |
| Deck slide templates + onboarding wizard | **`apps/web/src/routes/reports*`** | **73 files, 15,864 LOC** |
| Core schema footprint | `organization_settings.reports_only` (migration 128) | **one boolean column** |

Target is `REPORTS_INTERNAL_API_URL`, per-environment (prod vs stg), and it also
exposes `/api/v2/mcp`. So the app **already registers tools into Studio and owns
its own data.** This is the reference implementation, not a thing to design.

**What it proves:** an external service + a thin Studio binding works, ships on
its own cadence, and keeps its schema out of Core's 232 migrations.

**What it does not prove — and these are the two hard parts:**

1. **The view seam.** All 15,864 LOC of reports UI still lives in `apps/web` and
   still redeploys with the monolith. The backend is split; the frontend is not.
2. **The auth model.** Reports is reached with a **shared master key**, with
   Studio acting as a trusted server-side proxy. The app therefore cannot tell
   one user from another and cannot enforce RBAC itself — Studio does it on the
   way in. That is fine for one first-party service and does not generalize to N
   apps. §2.2 proposes scoped delegation instead.

Everything below is "do the Reports pattern properly, then do it everywhere."

### 2.1 Three fault domains, not N microservices

Do **not** split by domain noun (`users-service`, `tasks-service`). Split by
*blast radius tolerance*:

| Tier | What | Change rate | Deploy style |
|---|---|---|---|
| **Core** | auth, orgs, members, roles/RBAC, connections, vault/secrets, projects, repositories, audit, the MCP proxy, the event bus | low, must never break | slow, canaried, boring |
| **Apps** | reports/monitors, task-board, site-editor/CMS, jira, registry/store, hosting, library, analytics, experiments, every future surface | high — this is where all the change is | fast, independent, per-app rollback |
| **Execution** | sandboxes, agent runs, workers, previews | bursty | already separate pods; leave on k8s |

**Studio = Core.** It is the identity provider, the org model, the connection
registry, the MCP router, and nothing else. It is the thing we promise never goes
down. It is also the thing that should change least often — which is exactly what
makes a manual promotion gate acceptable *for Core only*.

Everything a user navigates to is an App.

### 2.2 What an App is

- Its own deploy target and its own release cadence. Merging an app change never
  touches Core.
- **Its own data.** Its own DB/D1/DO/KV. It never reads a Core table and never
  reads another app's tables. It gets `org_id` / `project_id` / `user_id` as
  opaque strings from Core and keys its own storage by them.
- Registers **tools** (MCP) and **views** (the surface) into Core. Studio renders
  the view the way it already renders MCP app views.
- Delegates auth to Core: OAuth against Studio, scoped token, RBAC check via Core.
- Subscribes to Core lifecycle events (`org.deleted`, `project.deleted`) on the
  event bus for cleanup and GDPR. The event bus already exists; this is finally a
  use for it.

The seam we want: **you can delete an entire app and Studio still boots.**

### 2.3 Where apps run — and the 128MB thing

Gimenes is right that 128MB is a real ceiling, and it is also irrelevant for most
of this. Route by workload shape, not by ideology:

| Shape | Target | Why |
|---|---|---|
| Tool server: reads a DB, calls an API, returns JSON (reports, task-board, jira, registry, library, analytics) | **Cloudflare Workers** | Deploy in seconds, per-app rollback, zero k8s, gradual deployments are built in. Memory never comes close. |
| Stateful coordination (live task board, collaborative editing, run fan-out) | **Durable Objects** | Replaces a chunk of what we use NATS + Postgres locking for. |
| Compute: sandboxes, builds, bundling, DuckDB/ClickHouse reads, image work | **Containers on k8s** | Real memory, real disk, real time limits. Stays exactly where it is. |
| Core | **k8s** (today) | No reason to move it. It benefits least from fast deploys and most from boring. |

This is not "move to Workers". It is "stop deploying a reports page through a
Kubernetes rolling update".

### 2.4 Data ownership — the part that makes or breaks this

Splitting the app without splitting the data produces a distributed monolith:
slower, and now with network partitions. Rules:

1. **Core owns the tenancy graph only**: user, organization, member, role,
   project, repository, connection, secret, audit. That table set should *stop
   growing*. Today it is 232 migrations and climbing.
2. **Apps own their own schema, in their own database.** A new feature = a new
   app = a new store = migrations whose blast radius is that one app.
3. **No cross-database joins, ever.** Cross-app reads are MCP tool calls. If that
   is too slow, the two things were one app.
4. **IDs are opaque.** An app stores `org_id` as a string. It does not have an FK
   to Core.
5. **Deletion is an event, not a cascade.** Core emits, apps clean up, apps
   acknowledge. At-least-once with retry is already built.
6. **Migrations are expand/contract, always.** Add column → deploy code that
   writes both → backfill → deploy code that reads new → drop old, in a *later*
   release. Enforce with a lint: a destructive DDL statement in the same release
   as the code that depends on it fails CI. This is what takes migrations off the
   deploy critical path — which in turn is what lets us auto-sync prod.

### 2.5 The frontend

`apps/web` is 320k LOC and 131 route files in one bundle. Today a copy change in
a report template rebuilds and redeploys the login screen.

- Keep **one shell**: nav, auth, org/project context, the chat surface. Small,
  slow-changing, deployed with Core.
- Every surface becomes a **remote view served by its own app**, loaded the way
  `project-app-view.tsx` already loads MCP app views.
- **No module federation.** We already have a working remote-view path; use it.

### 2.6 Deploys

Target: **merge → production in under 15 minutes, with no human in the path, and
an automatic rollback if it is bad.**

1. **Delete the manual ArgoCD sync for apps.** Apps deploy from their own
   pipeline; ArgoCD is not in the loop at all for them.
2. **Auto-sync prod for Core**, gated on evidence rather than on a person:
   staging green + smoke suite + canary healthy. The gate stays; the human leaves it.
3. **Progressive delivery.** We already run Gateway API + Istio and already build
   per-PR preview environments with their own namespace + Postgres + 48h TTL.
   Add Argo Rollouts (or weighted `HTTPRoute`): 5% → 25% → 100%, auto-abort on
   error-rate/latency regression. Blast radius per deploy goes from 100% of orgs
   to ~5%.
4. **Migrations out of the sync path.** With expand/contract, the migration job
   is an independent, idempotent pipeline step that never blocks a rollout and
   never needs the app to wait for it.
5. **Ship dark by default.** Every risky surface behind an `organization_settings.flags`
   toggle — the mechanism exists and is one line in `OrgFlagsSchema`. "Deployed"
   must never mean "enabled." Turn it on for deco's own org first, then the 5
   operated accounts, then everyone.

### 2.7 Honest math on "100x"

100 deploys/day across ~10 engineers is ~1 deploy per engineer per hour. That is
achievable and it is not achieved by making CI faster — it is achieved by
removing the four couplings above. Most of those deploys will be app deploys of
20–60 seconds. Core will keep deploying a few times a day, which is correct.

---

## 3. Sequencing

Each phase is independently valuable. Do not start phase 2 before phase 1 is done.

### Phase 0 — one week, no architecture change, biggest single win
- [ ] Auto-sync production for `deco-studio`, gated on staging health + smoke suite.
- [ ] Argo Rollouts / weighted HTTPRoute canary with automatic abort.
- [ ] One-command rollback, documented, rehearsed once on purpose.
- [ ] Dashboard: deploys/day, merge→prod lead time, change-failure rate, MTTR,
      % of orgs exposed per deploy. If we do not measure these, phase 1 is theater.

### Phase 1 — 2–4 weeks: finish Reports instead of extracting something new
Do **not** pick a fresh app. Reports is already half-extracted (§2.0); completing
it is smaller work, and it is the half nobody has proven.
- [ ] Move `apps/web/src/routes/reports*` (73 files, 15,864 LOC) out of the
      monolith and serve it from `decocms/reports` as an app-owned remote view,
      loaded the way `project-app-view.tsx` already loads MCP app views.
- [ ] Replace the shared master key with scoped delegation: Core issues a
      per-org, per-user token; Reports enforces its own RBAC instead of trusting
      a proxy. Retire `/api/_reports/*` once nothing needs it.
- [ ] Core exposes the contract this needs: OAuth, `org/project/user` resolution,
      RBAC check, event bus (`org.deleted` → Reports cleans up).
- [ ] Drop `organization_settings.reports_only` — it is UI-cosmetic and belongs
      in `flags`, not its own column.
- [ ] **Gate:** a reports UI change deploys without touching `apps/api` or
      `apps/web`, and rolls back alone.

That gate is the whole point. If it is painful, fix the Core contract before
extracting anything else — because every app after this inherits it.

### Phase 2 — 1–2 months: extract the rest, in usage order
Task-board → site-editor → jira → registry/store → hosting → library. Each one
leaves `apps/api` smaller. Core's migration count stops growing.

### Phase 3 — ongoing
- [ ] Per-app SLOs and error budgets. Core's budget is much tighter than an app's.
- [ ] A published, versioned Core contract so an app can be written by anyone —
      including the Super Agent. This is where "each agent is a separate app"
      becomes literally true, and where the MCP layer pays for itself.

---

## 4. What we should kill

> **Revised 2026-09-21** with a harder metric. The first pass counted *all*
> users over 30 days. That overstated everything, because
> `useControlPlaneViews()` unlocks hosting / analytics / e2e / monitor /
> experiments for `isDecoStaffEmail(...)` unconditionally — so a surface can
> look "used" when the only people in it are us. The table below counts
> **external (non-`@deco.cx`) users over 90 days**.

### 4.1 The evidence

| Surface | External users | External orgs | External views | Frontend LOC | Call |
|---|---:|---:|---:|---:|---|
| `analytics` | **0** | 0 | **0** | 2,262 | mid-migration — see §4.2 |
| `e2e` | **0** | 0 | **0** | 1,955 | mid-migration — see §4.2 |
| `experiments` | 1 | 1 | 5 | 511 | **delete** |
| `cdn` | 2 | 1 | 3 | 1,820 | mid-migration — see §4.2 |
| `git` | 3 | 3 | 4 | 21 + GitTab | fold into `repositories` |
| `hosting` | 3 | 2 | 58 | ~2,500 | mid-migration — the furthest along (granado) |
| `api-keys` | 5 | 4 | 6 | small | keep — security surface, low usage is correct |
| `assets` | 6 | 5 | 22 | 500 | fold into `library` (58 users) |
| `deck` | 6 | 6 | 45 | **72** | **keep** — 72 LOC, used weekly on farmrio/grupodass/montecarlo |
| `synced-repos` | 7 | 9 | 11 | — | fold into `repositories` |
| `infra-billing` | 8 | 8 | 17 | — | keep — it is money |
| `repositories` | 12 | 14 | 29 | — | keep (Core, set-and-forget) |
| `task-board` (settings) | 16 | 18 | 20 | — | keep |
| `skills` | 17 | 17 | 23 | — | keep |
| `sso` | 45 | 43 | 109 | — | keep (enterprise gate) |
| `roles` | 54 | 47 | 156 | — | keep (Core) |
| `library` | 58 | 42 | 108 | — | keep |
| `secrets` | 60 | 56 | 172 | — | keep (Core) |
| `buckets` | 60 | 56 | 164 | — | keep |
| `reports` | 63 | 37 | 145 | 8,351 | moving to `decocms/reports` |
| `store` | 64 | 58 | 207 | — | keep |
| `automations` | 64 | 58 | 204 | — | keep |
| `monitor` | 75 | 68 | 189 | — | keep — consolidation target |
| `members` | 85 | 71 | 301 | — | keep (Core) |
| `site-editor` | 103 | 36 | 1,967 | — | keep |
| `tasks` | 128 | 54 | 1,347 | — | keep — the product |
| `ai-providers` | 130 | 114 | 645 | — | keep (Core) |
| `connections` | 155 | 123 | 2,006 | — | keep (Core) |

Judge a **config** surface (sso, roles, secrets, api-keys, repositories) by
breadth — you set it once. Judge a **working** surface (analytics, e2e, cdn,
deck, tasks) by repeat use. Applying the wrong axis is how `secrets` looks dead
and `analytics` looks alive.

### 4.2 The deco.cx port is a migration, not a kill candidate

**Corrected 2026-09-21.** An earlier revision of this section read the zero
external users on `analytics` / `e2e` / `cdn` as "dead". That was backwards.

`analytics`, `e2e`, `cdn` and `hosting` are the **admin.deco.cx control plane
being ported into Studio so the old admin can be switched off** (M3). They are
BFF proxies to the old control plane:

- `analytics-tab` → `/api/:org/hosting/:site/…`
- `e2e-tab` + `e2e-run-detail` → `/api/:org/hosting/:site/e2e/*`
- `cdn-tab` → `/api/:org/monitor/:site/{cdn,audience}/`

backed by `api/routes/hosting.ts` (725 LOC) and `monitor.ts` (1,164 LOC).
**Zero external users means not-yet-migrated, not unwanted.** A surface cannot
be judged by usage before the migration that gives it users has happened.

So the question for this cluster is not "delete?" — it is:

1. **What is the date admin.deco.cx goes dark?** Until then this is ~8,500 LOC
   of frontend carried at full cost with 3 external users, and after it, it is
   the product. The date is the whole decision.
2. **Do `analytics` and `cdn` survive Monitors?** Monitors is the named
   consolidation target and already has 75 external users. Porting the old
   admin's analytics *and* building Monitors is building the same thing twice.
   If Monitors wins, the port should skip those two rather than finish them.
3. **Does `e2e` survive the QA agent?** Same shape of question.

None of that is a kill. It is a sequencing question that belongs to whoever
owns the deco.cx switch-off date.

### 4.3 Experiments — delete the feature, keep the hook

Two unrelated things share the word. Do not confuse them:

- **DELETE** the A/B *product feature*: `EXPERIMENT_*` tools (6),
  `apps/api/src/storage/experiments.ts`, `apps/api/src/deco-legacy/experiment-analytics.ts`,
  `experiments-tab.tsx` (511), migration `217-experiments.ts` + its table,
  `use-experiments.ts`, the `experiments_enabled` flag, i18n ×2,
  `packages/e2e/tests/experiments-tenancy.spec.ts`. **~1,700 LOC, 1 external
  user in 90 days.**
- **KEEP** `apps/web/src/hooks/use-experiment.ts` — that is the PostHog
  experiment reader described in `CLAUDE.md`. Unrelated.

We already pay PostHog for experiments and our own `CLAUDE.md` mandates using
it. Shipping a second, unused one is the definition of this document's problem.

### 4.4 Fold rather than delete

- `git` (3 users) and `synced-repos` (7) → one `repositories` page. Three
  surfaces for one concept.
- `assets` (6 users, 500 LOC) → `library` (58 users). Library already superseded it.

### 4.5 Corrections to the first pass

- **`deck` is not a kill.** 72 LOC, 6 external users, used weekly on the
  revenue accounts. The first pass called it a sales artifact; it is not.
- **`/settings/billing` is not a dead route.** It is already a redirect to the
  merged AI Providers page, and it is doing its job. Leave it.
- **The legacy `/:org/agents/*` tree is 926 LOC, not a big deletion.** The 31
  route files are 16–27 LOC wrappers; the weight is in the shared `*Tab`
  components. Still delete it — the value is one URL scheme instead of two, not
  lines removed.

### 4.6 Still unmeasured — fix this before guessing

- **The 176 `defineTool` tools are traced but not counted.** `define-tool.ts:180`
  opens an OTel span per call (`tool.<NAME>`), and non-error traces pass a **10%
  ratio sampler** (`observability/index.ts:179,276`). The counter that would
  answer "which tools are dead" — `tool.execution.count` in
  `monitoring/record-tool-execution-metrics.ts` — is wired **only** into
  outbound MCP calls (`mcp-clients/outbound/transports/monitoring.ts:212`), and
  early-returns without a `connectionId`, which management tools do not have.
  At 10% sampling a tool called twice a month reads as zero. Call
  `recordToolExecutionMetrics` from `define-tool.ts` too, let it run 30 days,
  then delete the zeroes.
- **`vm_preview_loaded`: 49,067 events from 96 users in 30 days** — ~510 per
  user per month on one event. That smells like a polling loop, which our own
  `CLAUDE.md` bans. Investigate before it becomes a cost or rate-limit incident.
- **"Mesh" naming.** The product is Studio. The repo is `mesh`, and
  `packages/mesh-sdk` + `mesh-plugin-*` remain. Rename once, fully. (The
  `apps/mesh`, `apps/studio` and `packages/mesh-plugin-*` directories on disk
  are untracked build leftovers — `git clean` them.)

### 4.7 Cost of ownership

4 Helm charts, a ClickHouse operator, a NATS subchart, an OTel collector, a DBOS
conductor, an Istio gateway, a sandbox operator with warm pools, a Toxiproxy
resilience suite and a multi-pod test suite — for 215 active users. Each is
defensible alone. Together they are why nobody wants to deploy. As apps move off
k8s, retire the parts that only existed to serve them.

### 4.8 Total

| Bucket | LOC |
|---|---:|
| Experiments feature | ~1,700 |
| Assets (folded into Library) | 500 |
| Legacy `/agents/*` route tree | 926 |
| Reports UI (moving to `decocms/reports`) | 15,864 |
| **Total** | **~19,000** |

The deco.cx port (~8,500 LOC) is deliberately **not** in this table — it is a
migration on a schedule, not a deletion. See §4.2.

Plus: 1 Postgres table, 1 migration, 6 MCP tools, 3 org flags, 2 i18n
dictionaries, and the `/e2e/*` + `/cdn|audience/*` BFF handlers.

---

## 5. What this does not fix

- It does not fix report quality, the broken report→task handoff, or the missing
  objectives layer. Those are product problems and this doc deliberately does not
  touch them.
- It does not make the Super Agent better.
- It adds a new failure mode: a Core contract change can break every app at once.
  That is the price, and it is why Core must be small, versioned, and slow.

---

## 6. Decisions needed before anyone writes code

1. **Do we auto-sync production?** (Phase 0 blocks on a yes.)
2. **Is "finish Reports" the pilot** (recommended), or do we extract something new?
3. **Cloudflare Workers as the default app runtime** — agreed, with containers
   for compute? (Gimenes.)
4. **Does an app get its own repo, or a folder in this monorepo with its own
   pipeline?** Own repo is cleaner for blast radius; monorepo is cheaper for
   shared types. Recommendation: monorepo folder + independent pipeline first,
   own repo only when a team owns it.
5. **Who owns the Core contract** and its versioning?
6. **Sign-off on the kill list in §4** — the `experiments` feature, folding
   `git`/`synced-repos` into `repositories` and `assets` into `library`, and the
   legacy `/agents/*` tree. `deck` and `/settings/billing` came off the list.
7. **A date for admin.deco.cx going dark** (§4.2), and whether `analytics` and
   `cdn` should be finished or superseded by Monitors. Owner needed.

---

## Appendix — how the current deploy actually works

```
PR ──merge──▶ main
   └─▶ release-tagging.yaml   commits "[release]: bump …" (apps/api/package.json)
                               stamps `Deploy-Scope: web|server|both`
       └─▶ release-studio.yaml            (6–16 min)
              build-dist → publish-npm
              build-docker (studio) ─┐
              build-nginx-docker ────┴─▶ merge manifests (multi-arch)
              └─▶ repository_dispatch `studio-image-bump` → decocms/deco-apps-cd
                     ├─ deco-studio-stg   auto-sync   ▶ STAGING rolls out
                     └─ deco-studio       manual-sync ▶ desired state only
                                                        ⛔ A HUMAN CLICKS SYNC
                            └─▶ ArgoCD ▶ Helm
                                   ├─ migrate Job (sync-wave -10, BLOCKS the sync)
                                   └─ Deployment (api+nginx) + worker Deployment
                                        ▶ 100% of traffic, no canary, no auto-rollback
```
