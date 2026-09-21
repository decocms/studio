# Studio — system inventory

**Status:** descriptive, not a plan · **Branch:** `gui/blast-radius` · **Date:** 2026-09-21
**Companion:** [`BLAST-RADIUS.md`](BLAST-RADIUS.md) (that one proposes; this one only describes)

> Purpose: give the team one place to see **what exists, how big it is, and what
> infrastructure it drags behind it** — so a conversation about what to change
> starts from shared numbers instead of shared impressions.
>
> Nothing here says what to do.

---

## 0. Two corrections to the earlier read

**a. Tool telemetry exists. I described it wrong.**

`defineTool` (`apps/api/src/core/define-tool.ts:180`) opens an OTel span per
call — `tool.<NAME>`, with `tool.name` / `organization.id` / `user.id`. That is
real telemetry.

What it does **not** do is *count*. The counter and histogram
(`tool.execution.count`, `tool.execution.duration`) live in
`monitoring/record-tool-execution-metrics.ts` and are called from exactly one
place: `mcp-clients/outbound/transports/monitoring.ts:212` — **outbound** MCP
calls to connected servers. It early-returns without a `connectionId`, which
Studio's own management tools do not have.

So the 176 `defineTool` tools are **traced but not counted**, and traces fall
through a **10% ratio sampler** for non-errors
(`observability/index.ts:179,276`). A tool called twice a month has roughly an
80% chance of showing zero spans in a month — which is exactly the question
"which tools are dead?" needs answered. The gap is narrow and the fix is one
call site, but the data genuinely is not there today.

**b. `analytics`, `e2e`, `cdn`, `hosting` are a migration, not dead features.**

They are the **admin.deco.cx control plane being ported into Studio** so the old
admin can be switched off. Zero external users means *not yet migrated*, not
*unwanted*. The earlier framing ("delete, nobody uses them") had the causality
backwards, and §3 below reflects the correction.

The useful question for this cluster is not "delete?" but **"what is the date
admin.deco.cx goes dark, and is the porting rate on track for it?"** — because
until that date, these surfaces are cost with no revenue, and after it they are
the product.

---

## 1. How to read the numbers

- **LOC** is non-test TypeScript/Go, `node_modules` and `dist` excluded. It
  measures *surface to maintain*, not value and not effort.
- **External users** = distinct non-`@deco.cx` users in 90 days (PostHog
  project `studio`). Deco staff are excluded because
  `useControlPlaneViews()` unlocks several surfaces for staff unconditionally.
- **Config surfaces are set once.** Low repeat use on `sso`/`secrets`/`roles`
  is correct behaviour, not decay. Judge those by breadth.
- **A surface mid-migration has no users yet by definition.** See §0b.

Totals for scale: `apps/api` ≈ **276k LOC**, `apps/web` ≈ **320k LOC**,
232 Kysely migrations, 176 `defineTool` tools, 96 API route files,
215 active app users / 154 orgs (30d).

---

## 2. Feature domains

Sorted by total LOC. "Infra" lists what the domain needs *beyond* Postgres,
which every domain uses.

| Domain | API LOC | Web LOC | Tools | Ext. users (90d) | Infra beyond Postgres | Notes |
|---|---:|---:|---:|---:|---|---|
| **Sandbox / agent execution** | 957 + 15.3k harnesses + **27k** `packages/sandbox` | 28,622 | 2 | — (indirect) | **k8s + agent-sandbox CRDs, warm pools, orgfs sidecar, Istio gateway, NATS, S3** | Largest system in the company. Go daemon (17k) + server (7k) + orgfs (1.6k). Health probe kills the pod on a single miss. |
| **Chat / threads** | 1,095 | 26,308 + 9,785 | 6 | 128 (via tasks) | NATS (SSE fan-out), AI providers | 25 migrations. `chat` + `thread` are two web trees for one concept. |
| **CMS / sections editor** | 2,330 `decofile` | 24,073 | — | 103 (`site-editor`) | Git providers, S3 | The deco.cx admin's editing surface, reborn. |
| **Task board** | **12,020** | 10,282 | 17 | 128 | NATS, DBOS, sandbox, git providers, Jira | Biggest tool domain by far; **44 migrations**. The product. |
| **Git providers** | 12,657 | — | 2 | 12 (`repositories`) | GitHub App, GitLab, Bitbucket APIs | Three provider implementations behind one interface. 9 migrations. |
| **Settings (all orgs)** | — | 11,127 | — | 45–130 by page | — | 20 settings routes; most are thin over Core tools. |
| **Registry / store** | 3,587 | 7,554 | **27** | 64 | — | 27 tools — the largest tool count per surface in the repo. |
| **Virtual MCP** | 2,271 | 7,203 | 9 | — | MCP proxy | `vm_preview_loaded` fires 49k times/month from 96 users (§4). |
| **Organization / auth / RBAC** | 2,482 + 3,934 auth | (in settings) | 22 | 155 (`connections`) | Better Auth, OAuth, vault | **Core.** 25 migrations. Everything depends on it. |
| **Connections + MCP proxy** | 2,244 + 4,183 | 813 | 6 | 155 | Outbound HTTP, OAuth proxy, credential vault | **Core.** The actual "MCP control plane". 12 migrations. |
| **deco.cx control-plane port** | 1,889 (`hosting.ts`, `monitor.ts`) | ~6,000 tabs + ~2,500 hosting | — | 0–3 | ClickHouse, DuckDB, old control plane | **Mid-migration** — see §0b and §3. |
| **Reports / diagnostics** | 1,332 | 15,864 | 5 | 63 | External engine (`decocms/reports`) | Engine already external; UI moving out. 2 migrations. |
| **Automations** | 1,403 + 1,329 | 1,698 | 10 | 64 | DBOS, dispatch queue | 9 migrations. |
| **AI providers / gateway** | 1,043 + 1,454 | — | 15 | 130 | OpenRouter, Anthropic, provider OAuth | **Core-adjacent.** Second-most-used surface. |
| **Jira integration** | 870 + 3,584 | — | 5 | — | Jira Cloud API, webhooks | 9 migrations for one customer integration. |
| **Monitoring / observability store** | 639 + 2,063 | 1,653 | 5 | 75 | **ClickHouse + DuckDB + OTel + S3/GCS** | Consolidation target for Signals. 5 migrations. |
| **Object storage / files / org-fs** | 305 + 1,101 + 4,314 | — | 6 | 60 (`buckets`) | S3 / MinIO | Library + per-user FS + uploads. |
| **API keys / secrets / vault** | 594 + 112 + 63 | — | 6 | 5 / 60 | Encryption at rest | **Core.** Small, security-critical. |
| **Guides** | 1,259 | — | 0 | — | — | 1,259 LOC, zero tools. Worth a look. |
| **Experiments (A/B feature)** | 413 + storage | 511 | 6 | 1 | — | Distinct from the PostHog hook. 1 migration. |
| **Infra billing** | 254 + 2,485 `billing` | — | 3 | 8 | Stripe | |
| **Notifications** | 197 + 659 | — | 3 | — | NATS, email | |
| **Event bus** | 425 | — | 6 | — | NATS | Built, documented, largely unused. |

### 2.1 Where the weight actually is

| Rank | System | Total LOC | Share |
|---:|---|---:|---:|
| 1 | Sandbox / agent execution | ~72,000 | ~12% |
| 2 | Chat + threads | ~37,000 | ~6% |
| 3 | Task board | ~22,000 | ~4% |
| 4 | CMS / sections editor | ~26,000 | ~4% |
| 5 | Reports UI (leaving) | ~16,000 | ~3% |
| 6 | Git providers | ~13,000 | ~2% |
| 7 | Registry | ~11,000 | ~2% |
| 8 | deco.cx port | ~10,000 | ~2% |

The top three are ~22% of the codebase and carry ~all of the runtime
infrastructure. **Sandbox alone is bigger than the entire Studio API's tool
layer.**

---

## 3. The deco.cx port, specifically

One cluster, four surfaces, one destination: switch off admin.deco.cx.

| Surface | Web LOC | Backend | Ext. users | Ext. views |
|---|---:|---|---:|---:|
| `hosting` (deploys, domains, env, redirects, secrets) | ~2,500 | `api/routes/hosting.ts` (725) | 3 | 58 |
| `analytics` | 2,262 | `/api/:org/hosting/:site/…` | 0 | 0 |
| `e2e` (checks + run detail) | 1,955 | `/api/:org/hosting/:site/e2e/*` | 0 | 0 |
| `cdn` + audience | 1,820 | `api/routes/monitor.ts` (1,164) → `/cdn`, `/audience` | 2 | 3 |

All four are BFF proxies to the **old control plane** — so they carry a
dependency on a system we are trying to retire, plus ClickHouse (CDN/audience
queries) and DuckDB (monitoring reads).

Gated by `useControlPlaneViews()`:
`staffOrLocal || controlPlaneGa || useOrgFlag("<x>_enabled")` — flags
`hosting_enabled`, `deco_analytics_enabled`, `e2e_enabled`, `monitor_enabled`,
`experiments_enabled`. Staff see everything regardless, which is why internal
clicks dominated the first measurement.

Facts worth having in the room, without a recommendation attached:
- ~8,500 LOC of frontend is written and serving **3 external users total**.
- It cannot be judged by usage until the migration completes.
- It duplicates two future systems by design: `analytics` and `cdn` overlap
  **Monitors** (the named consolidation target, 75 external users), and
  `e2e` overlaps the QA agent.
- The cost is carried every day the switch-off date slips.

---

## 4. Infrastructure inventory

| Piece | Where | Who needs it | Fails how | Blast radius |
|---|---|---|---|---|
| **PostgreSQL** | managed (prod), embedded (dev) | everything | 232 migrations, one schema, one DB | **total** |
| **Migration Job** | Argo Sync hook, wave −10 | every deploy | blocks the whole sync when it hangs; a blocked op cannot be superseded | **total** |
| **NATS** | helm subchart 2.14.2 | SSE fan-out, event bus, agent dispatch, notify | JetStream stream poison keeps the pod out of the Service permanently (documented in Chart.yaml) | real-time + dispatch |
| **DBOS** | SDK + optional cloud conductor | durable workflows, automations, task runs | migrates its own schema on every pod boot; concurrent first boots **brick the DB permanently** (why the migrate Job exists) | **total, unrecoverable** |
| **ClickHouse** | operator + cluster subcharts (2 charts) | monitoring, CDN/audience analytics | optional (`enabled: false` by default) | analytics only |
| **DuckDB** | in-process, httpfs baked into the image | monitoring reads from GCS/S3 | needs glibc → the image is debian-slim, not alpine; needs the OS CA bundle | monitoring |
| **S3 / MinIO** | external (prod), bundled (dev) | files, org-fs, library, sandbox artifacts, e2e runs | — | files + sandboxes |
| **OTel collector + Prometheus + OTLP** | helm subchart 0.147.2 | all tracing/metrics/logs | 10% sampling for non-error traces | observability only |
| **Kubernetes + agent-sandbox operator** | `sandbox-operator` chart + CRDs | every agent run | health probe: **one missed poll ⇒ sandbox marked dead, pod torn down mid-session** | all agent work |
| **Sandbox warm pools / housekeeper / orgfs sidecar** | `sandbox-env` chart, 15 templates | sandbox latency + per-org FS | housekeeper sweep, golden cache, tenant pools | sandbox latency |
| **Istio + Gateway API** | cluster | preview routes, per-PR previews | Gateway `allowedRoutes` matches **namespace labels**; a mismatch attaches the route to nothing, silently | previews |
| **nginx** | second image, own build + push | serves the SPA in front of the API | doubles the release pipeline's docker work | serving |
| **Cloudflare** | external | hosting control plane, CDN, `packages/cf-sandbox` | — | hosting |
| **Better Auth** | in-process + own migration CLI | all auth | **a second migration system** (`better-auth:migrate`) beside Kysely | **total** |
| **ArgoCD + `decocms/deco-apps-cd`** | external repo | all deploys | prod app is **manual-sync** | deploy velocity |
| **GitHub App / GitLab / Bitbucket** | external | repos, PRs, previews, webhooks | one webhook URL for the whole app | git-backed work |

### 4.1 Helm surface

| Chart | Templates | Subcharts | Purpose |
|---|---:|---:|---|
| `studio` | 24 | 4 (nats, otel-collector, clickhouse-operator, clickhouse-cluster) | the app |
| `sandbox-env` | 15 | — | warm pools, housekeeper, golden cache, preview gateway, orgfs |
| `sandbox-operator` | 3 | vendored CRDs | agent-sandbox |
| `studio-previews` | 5 | — | per-PR environments |

`deploy/helm/studio/Chart.yaml` carries **15 documented incident-driven version
bumps** in its changelog (sync-wave ordering, ServiceAccount timing, ConfigMap
timing, spot-reclaim data loss, mutable preview tags, namespace adoption, NATS
probes, DBOS migration collisions). That changelog is the single best artifact
for judging this layer's cost — read it before any architecture discussion.

### 4.2 Test and CI surface

| Suite | Needs | Runtime |
|---|---|---|
| `bun test` (unit) | nothing | 1–7 min |
| Playwright e2e (`packages/e2e`) | real Postgres + NATS + Better Auth, `apps/api` + `apps/web` spawned | 4–7 min |
| Resilience (`tests/resilience`) | Docker Compose + **Toxiproxy** | on demand |
| Multi-pod (`tests/multi-pod`) | Docker Compose, proves the DBOS collision | on demand |
| Daemon e2e (`packages/sandbox/daemon-e2e`) | built Go binary | — |
| `helm-test` | helm render + object-ordering assertions | — |
| Native (`apps/native`) | macOS signing identity + keychain helper | — |

---

## 5. Things the numbers surface, without a conclusion

1. **`guides`: 1,259 LOC in `apps/api/src/tools/guides`, zero `defineTool`.**
   Nobody has looked at what it is recently.
2. **`vm_preview_loaded`: 49,067 events from 96 users in 30 days** — ~510 per
   user per month, on one event. Our `CLAUDE.md` bans polling. Worth a trace.
3. **Two web trees for one concept**: `components/chat` (26k) and
   `components/thread` (9.8k). Also `layouts/task-board` (10k) vs
   `components/task-board` (36 LOC).
4. **Two migration systems**: Kysely (232) and Better Auth (its own CLI). Both
   must run, in order, on every deploy.
5. **Registry has 27 tools for 64 external users**; task-board has 17 tools for
   128. Tool count does not track usage.
6. **Jira: 9 migrations and 4,454 LOC** for a per-customer integration.
7. **Event bus is built, documented at length in `CLAUDE.md`, and barely used** —
   425 LOC + 6 tools + a migration, waiting for a consumer.
8. **The sandbox is ~72k LOC and every bit of the k8s dependency.** Any
   conversation about leaving Kubernetes is a conversation about this system
   and nothing else.

---

## 6. What this document does not contain

No recommendations, no sequencing, no kill list. Those are in
[`BLAST-RADIUS.md`](BLAST-RADIUS.md), which should be read as a proposal to
argue with, not as a companion of equal confidence to this one.
