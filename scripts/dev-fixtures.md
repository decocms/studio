# Dev fixtures — a local project with every page populated

Design work on the project pages needs a project that actually has data in
every row. These scripts build one in local dev, and this is how to bring it
back up after a reboot.

The seeds name the project **Demo Store**, site slug `demo-store`, repo
`deco-sites/storefront`, in the first org they find (`--org=<slug>` to pick
one). Everything is idempotent, so re-running is the fix for drift.

## Row by row

| row | state | source |
| --- | --- | --- |
| Início (overview) | real | task board feed + composer, both real DB |
| Relatórios | empty state only | the report itself is an EXTERNAL app (Commerce Discovery MCP). Studio's own empty state renders; a real report needs `REPORTS_INTERNAL_API_URL` / `_KEY` pointing at the real service |
| Tarefas (board) | real | 13 seeded cards across all 9 canonical lanes, 14 tags, comments, activity, due dates, assignees |
| Editor do site | **blocked** | needs a sandbox. `agentSandboxEnabled()` is `!localMode && STUDIO_AGENT_SANDBOX_ENABLED`, and the hosted provider is Kubernetes (Pod + Sandbox CR watches). The local path is the native app (`bun run --cwd=apps/native dev`), whose local-api owns the sandbox |
| Assets | real | `static` file config on the dev MinIO bucket (`studio-dev`) under a `demo-store/` prefix, seeded with 6 placeholder files. Uploads and listing work; previews need a public bucket (see Known gaps) |
| Hospedagem / E2E / Deco Analytics | needs the upstreams wired (`CONTROLPLANE_*` / `ANALYTICS_*`) | — |
| Monitor | half real SQL | Performance reads the local ClickHouse (`scripts/dev-monitor-seed.ts`). Audience stays on the unconfigured state: it reads OneDollarStats, whose base URL is a hardcoded constant in the app, and redirecting it would mean editing `apps/api` |
| Automações | real | empty until one is created |
| Configurações | real | — |
| App views | real | `scripts/dev-mcp-app.ts` — a local MCP server whose tools carry `_meta.ui.resourceUri`, so Studio lists them as views and iframes the HTML they resolve to |

## The two gate groups (`project-sidebar-views.ts`)

1. **Clonable source** — Início / Relatórios / Tarefas / Editor do site appear
   only when `metadata.githubRepo.url` is set (public-clone mode is enough).
2. **Resource-backed** — Assets needs a file config owning the slug; Hosting /
   E2E / Analytics / Monitor need the upstreams wired (env, pointing at a real
   control-plane/analytics deployment), the project's `metadata.siteSlug`, AND
   the org owning that slug in `org_sites` (else both BFFs answer 404 and the
   rows stay hidden). Local mode passes the per-view rollout gate, so no org
   flag is needed.

## One command

```bash
bun run dev                              # in this workspace
bun run scripts/dev-fixtures.ts --detach # in another terminal
```

That writes the upstream vars into `.env` (only the keys you do not already
have), starts the ClickHouse container and seeds it, starts the mock app
server, finds the dev home **this** workspace is running — each one gets its
own Postgres and MinIO under `/tmp/decocms-dev-<workspace>` — and runs the
seeds against it. Everything is idempotent, so re-run it whenever a page looks
empty.

Two things to know:

- If it says it added env keys, restart `bun run dev`: `--hot` does not reload
  process env, so the BFFs keep the old (absent) upstreams until you do.
- With several workspaces open it picks by workspace name; when that is
  ambiguous it lists the homes and takes `--home=<slug>`.

Without `--detach` it stays in the foreground owning the mock server, so
ctrl-c takes the fixture down with it. The steps below are the same thing by
hand.

## Pieces

| piece | what it is |
| --- | --- |
| `scripts/dev-seed-demo-project.ts` | Claims the slug, creates/updates the project (githubRepo + siteSlug + all sidebar rows), seeds the task board, and provisions the MinIO assets config + files. Idempotent. Lives at the repo root and imports `apps/api`'s storage classes — it changes nothing there. |
| `scripts/dev-monitor-seed.ts` | Seeds a **real local ClickHouse** with the stats-lake tables the Monitor tab queries. No SQL is faked. |
| `scripts/dev-mcp-app.ts` | An **MCP server with UI tools** (MCP Apps) on `:8789/mcp`, speaking streamable-HTTP JSON-RPC. Three tools carry a `ui://` resource (Pedidos por hora, Alertas de estoque, Funil de vendas) and one deliberately does not, so the views list proves it filters. Each app is a single HTML file that does the ext-apps postMessage handshake by hand and pulls its data back through `tools/call` — the injected CSP is `default-src 'none'`, so it cannot fetch a bundle. |
| `scripts/dev-seed-mcp-app-connection.ts` | Attaches that server to the project as a real `HTTP` connection. Leaves `connections.tools` null so Studio fetches `tools/list` live. `--pin` also pins every view to the sidebar. |
| `dev-fixtures.ts` | The one command above: env, ClickHouse, mocks, seeds, in that order. |
| `dev-seed-org.ts` | Which org the seeds write into: the first one that **has a member**, since a local DB also carries memberless system orgs. |
| `.env` | `CONTROLPLANE_*`, `ANALYTICS_*`, `CLICKHOUSE_ANALYTICS_*` — gitignored, which is why a fresh workspace shows nothing until the script writes them. |

## Bring it up by hand

```bash
# 1. warehouse (once per boot)
docker start deco-monitor-clickhouse   # or the docker run in dev-monitor-seed.ts's header
bun run scripts/dev-monitor-seed.ts    # (re)seed, or move the window forward

# 2. mcp app server, for the app-views half of the settings (keep running)
bun run scripts/dev-mcp-app.ts

# 3. studio
bun run dev

# 4. the project — postgres and MinIO ports are per-boot, read them off the
#    dev log ("System Database URL", the minio --address)
DATABASE_URL=postgresql://postgres:postgres@localhost:<pg>/postgres \
S3_ENDPOINT=http://127.0.0.1:<minio> \
  bun run scripts/dev-seed-demo-project.ts

# 5. the MCP app connection
DATABASE_URL=postgresql://postgres:postgres@localhost:<pg>/postgres \
  bun run scripts/dev-seed-mcp-app-connection.ts
```

The ClickHouse window is anchored to *today* at seed time, so re-run its seed
after a few days or the presets look empty at the right edge.

## URLs

Both seed scripts print the project's URLs when they finish. The shape is
`/<org>/agents/<row>?virtualmcpid=<project id>`, where `<row>` is `overview` ·
`reports` · `board` · `site-editor` · `assets` · `hosting` · `e2e` ·
`analytics` · `cdn` (Monitor) · `automations` · `settings`.

## What is real vs simulated

- **Real**: the whole Studio path (auth, org resolution, `org_sites` tenancy,
  both BFFs, the admin write gate, every UI component), the task board, the
  assets bucket, and every Monitor query against ClickHouse.
- **Real, but needs an upstream**: Hosting / E2E / Deco Analytics have no local
  stand-in. Without `CONTROLPLANE_*` / `ANALYTICS_*` pointing at a real
  control-plane and analytics deployment, those rows show their unconfigured
  state.

## What this required in the app

**Nothing under `apps/api`.** Every upstream is reached through env vars the
app already reads, and the seed script only *imports* api storage classes.

In `apps/web`, one bug fix came out of it: `fmtMetric` in `analytics-tab.tsx`
now runs the duration branch before the percentage branch — `duration_s`
matched `/ratio/` (via "du-**ratio**-n") and rendered "171%" instead of
"2m 51s".

## Known gaps

- **Monitor › Audience** stays on the unconfigured state (see the table).
- **Assets thumbnails** 404: the dev MinIO bucket is not anonymously readable,
  so the grid shows names/sizes but no previews. `mc anonymous set download
  local/studio-dev` fixes it if you have `mc`; listing, upload and picking work
  either way.
