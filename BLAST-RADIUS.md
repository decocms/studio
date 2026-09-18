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

From PostHog, `studio` project, last 30 days. Total active app users: **215**.
Unique users per surface:

| Surface | Users/30d | Call |
|---|---|---|
| `home` | 183 | keep |
| `tasks` | 135 | keep — the product |
| `site-editor` | 119 | keep |
| `settings/general` | 95 | keep |
| `reports` | 72 | keep the engine; the **15,864 LOC of deck UI in `apps/web` is the liability** — move it out (Phase 1), and consolidate with `monitor` rather than maintaining both |
| `library` | 68 | keep |
| `connections` | 67 | keep (Core) |
| `ai-providers` | 62 | keep (Core) |
| `members` | 41 | keep (Core) |
| `automations` | 36 | **merge into tasks or kill** |
| `monitor` | 30 | merge into Monitors |
| `task-board` (settings) | 28 | keep |
| `skills` | 24 | keep |
| `store` (registry) | 24 | **demote** — out of nav, keep the route |
| `repositories` | 24 | keep (Core) |
| `infra-billing` | 21 | keep — it is money |
| `buckets` | 20 | **demote** |
| `sso` | 19 | keep — enterprise gate, low usage is expected |
| `secrets` | 18 | keep (Core) |
| `roles` | 14 | keep (Core) |
| `assets` | 13 | **kill** — superseded by Library |
| `deck` | 11 | **kill from the product** — it is a sales artifact, it belongs on the site |
| `hosting` | 11 | keep behind its flag; it is a real bet, just early |
| `cdn` | 9 | fold into hosting |
| `synced-repos` | 8 | **kill or fold into repositories** |
| `billing` | 6 | **dead route** — `infra-billing` is the live one |
| `e2e` | 5 | **kill** |
| `analytics` | 5 | **kill** — overlaps monitoring + PostHog |
| `git` | 4 | **kill** — overlaps repositories |
| `api-keys` | 3 | keep (Core, security surface) |
| `experiments` | 3 | **kill from the product** — we have PostHog experiments |

### Kill for structural reasons, not usage
- **The entire legacy `/:org/agents/*` route tree.** The projects migration is
  "live" but we still serve both URL schemes: 31 tracked files under
  `apps/web/src/routes/workspace/agent-*`, plus `agents-list.tsx` and
  `legacy-agents-deep.tsx`. Two navigations for one concept, double the surface
  to test and break. Redirect `/agents/*` → `/projects/*` and delete the tree.
- **`vm_preview_loaded`: 49,067 events from 96 users in 30 days.** ~510 events
  per user per month on one event. That smells like a polling loop, which our own
  CLAUDE.md bans ("Push events, don't poll"). Investigate before it becomes a
  cost or a rate-limit incident.
- **"Mesh" naming.** The product is Studio. The repo is `mesh`, and we still carry
  `packages/mesh-sdk`, `mesh-plugin-*`, `apps/mesh`. Rename once, fully. (The
  `apps/mesh`, `apps/studio` and `packages/mesh-plugin-*` directories on disk are
  untracked build leftovers — `git clean` them.)
- **176 `defineTool` tools with no server-side usage telemetry.** We cannot make
  an honest kill list for tools because we do not measure them. Add a counter to
  `defineTool` (it already wraps every call with tracing and metrics — this is a
  one-line addition), let it run 30 days, then delete anything with zero calls.
  Expect to delete a lot.

### Kill for cost-of-ownership
- 4 Helm charts, a ClickHouse operator, a NATS subchart, an OTel collector, a
  DBOS conductor, an Istio gateway, a sandbox operator with warm pools, a
  Toxiproxy resilience suite and a multi-pod test suite — for 215 users. Every
  one of these is defensible alone. Together they are why nobody wants to deploy.
  As apps move off k8s, aggressively retire the parts of this that only existed
  to serve them.

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
6. **Sign-off on the kill list in §4** — specifically `assets`, `deck`, `e2e`,
   `analytics`, `git`, `experiments`, `billing`, `synced-repos`, and the legacy
   `/agents/*` tree.

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
