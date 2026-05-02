# deco Studio

> Open-source control plane for your AI agents.

This is the full-stack [deco Studio](https://decocms.com/studio) app — a Hono API server, React 19 admin UI, and built-in MCP management tools — published to npm as [`decocms`](https://www.npmjs.com/package/decocms) (also installable as [`decostudio`](https://www.npmjs.com/package/decostudio)).

Studio centralizes Model Context Protocol (MCP) traffic for teams: agents, connections, projects, observability, and a token vault behind one governed endpoint.

## What it does

- **Agents** — browse, hire, and compose specialized AI agents with tracked skills and cost attribution
- **Connections** — register MCP services with one-click OAuth; route traffic through one governed endpoint with auth, proxy, and audit
- **Projects** — group agents and connections around a goal; the UI adapts to what's inside
- **Virtual MCPs** — compose and expose governed toolsets as new MCP endpoints (full-context, smart selection, or sandboxed code execution)
- **Token vault** — AES-256-GCM encrypted credential storage; share access without sharing credentials
- **Event bus** — pub/sub between connections (CloudEvents v1.0) with at-least-once delivery, scheduled and cron events
- **Bindings** — capability contracts so tools target interfaces, not specific implementations
- **Access control** — RBAC via Better Auth (OAuth 2.1 + SSO + API keys), workspace and project scoped
- **Observability** — OpenTelemetry traces, metrics, and logs; cost attribution per connection and agent

## Quick Start

The fastest way to run Studio is via npm — no clone required:

```bash
bunx decostudio
```

This boots Studio at [http://localhost:3000](http://localhost:3000) with embedded PostgreSQL. Private by default. Data lives in `~/deco/`.

```bash
bunx decostudio -p 8080            # custom port
bunx decostudio --home ~/my-app    # custom data directory
bunx decostudio dev                # dev mode (Vite hot reload + Ink TUI)
bunx decostudio init my-app        # scaffold a new MCP app
bunx decostudio services up        # manage local services (Postgres, NATS)
bunx decostudio --help             # full CLI reference
```

## Run from source

```bash
git clone https://github.com/decocms/studio.git
cd studio
bun install
bun run dev          # client + server with hot reload (from repo root)
```

Or from inside `apps/mesh/`:

```bash
bun run --cwd apps/mesh dev:client     # Vite dev server (port 4000)
bun run --cwd apps/mesh dev:server     # Hono server with hot reload
bun run --cwd apps/mesh migrate        # Kysely migrations
bun run --cwd apps/mesh better-auth:migrate  # Better Auth tables
```

### Optional: run NATS for low-latency event bus

By default, the event bus uses polling to wake up workers. For lower latency and better multi-replica coordination, run a local [NATS](https://nats.io) server:

```bash
brew install nats-server  # macOS — see https://docs.nats.io for other platforms
nats-server
```

Then set `NATS_URL=nats://localhost:4222` in your `.env`. Studio automatically switches to the NATS notify strategy; polling stays active as a safety net.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Cursor / Claude│────▶│ deco Studio  │────▶│  GitHub MCP     │
│  VS Code / Custom     │   (Proxy)    │     │  Slack MCP      │
└─────────────────┘     └──────────────┘────▶│  Your APIs      │
                              │              └─────────────────┘
                    ┌─────────┴──────────┐
                    │ Auth & RBAC        │
                    │ Token Vault        │
                    │ Event Bus          │
                    │ Audit & Observability │
                    └────────────────────┘
```

### Project Structure

```
apps/mesh/
├── src/
│   ├── api/             # Hono HTTP + MCP proxy routes
│   ├── auth/            # Better Auth (OAuth 2.1 + SSO + API keys)
│   ├── core/            # MeshContext, AccessControl, defineTool
│   ├── tools/           # Built-in MCP management tools
│   │                    # (connection, organization, eventbus, virtual,
│   │                    #  monitoring, ai-providers, automations, …)
│   ├── storage/         # Kysely DB adapters
│   ├── event-bus/       # Pub/sub event delivery (NATS + polling)
│   ├── encryption/      # Token vault & credential management
│   ├── observability/   # OpenTelemetry tracing & metrics
│   └── web/             # React 19 admin UI (Vite + TanStack Router)
├── migrations/          # Kysely migrations
├── scripts/             # Build & bundle scripts
└── spec/                # Design specs
```

### Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun (Node-compatible) |
| API | Hono |
| Database | Kysely → embedded PostgreSQL (dev) / PostgreSQL (prod) |
| Auth | Better Auth (OAuth 2.1, SSO, API keys, Organization plugin) |
| Frontend | React 19 + TanStack Router + TanStack Query |
| Styling | Tailwind CSS v4 + shadcn |
| MCP | `@modelcontextprotocol/sdk` |
| Observability | OpenTelemetry + Prometheus |

## API

### Management API (`/mcp`)

Exposes Studio's built-in management tools (organization, connection, project, event bus, monitoring, virtual MCPs, …) over the MCP protocol. Discover the full list at runtime:

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Proxy API (`/mcp/:connectionId`)

Proxies requests to downstream MCP services with credential injection, permission checks, and audit logging:

```bash
curl -X POST http://localhost:3000/mcp/conn_abc123 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"SEND_EMAIL","arguments":{}},"id":1}'
```

The proxy validates the token, checks permissions for the tool, decrypts the connection's credentials, forwards the request, and writes the call to the audit trail.

### OAuth 2.1

Studio implements the full MCP OAuth specification (Authorization Server, Resource Server, Dynamic Client Registration, PKCE):

```
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-authorization-server
POST /api/auth/register
```

## Configuration

Environment variables (all optional — Studio auto-generates secrets and uses sensible defaults):

```bash
PORT=3000                           # Server port
DATA_DIR=~/deco/                    # Data directory (DB, vault, monitoring spans)
DATABASE_URL=postgresql://…         # External Postgres (omit to use embedded)
BETTER_AUTH_SECRET=<32 bytes>       # Auth signing secret
ENCRYPTION_KEY=<32 bytes>           # Credential vault key
NATS_URL=nats://localhost:4222      # Optional: enable NATS notify strategy
NODE_ENV=production                 # Production mode
CLICKHOUSE_URL=http://localhost:8123  # Optional: remote ClickHouse for prod monitoring
```

Custom auth providers (Google, GitHub, SAML, magic-link, …) live in `auth-config.json`. See [`auth-config.example.json`](./auth-config.example.json) for the full shape.

## Development

```bash
bun run dev               # client + server (with migrations)
bun run dev:client        # Vite only
bun run dev:server        # Hono only
bun run check             # TypeScript
bun run test              # Bun test runner
bun run build:client      # production client bundle
bun run build:server      # production server + CLI bundle
bun run start             # run production build
```

Tests are co-located (`*.test.ts`). Run a single file:

```bash
bun test src/core/access-control.test.ts
```

## Deployment

### Docker

Pre-built multi-arch images (amd64, arm64) are published on every release:

```bash
docker run -d \
  -p 3000:3000 \
  -v studio-data:/app/data \
  --name studio \
  ghcr.io/decocms/studio/mesh:latest
```

### Compose with external Postgres

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: studio
      POSTGRES_USER: studio
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data

  studio:
    image: ghcr.io/decocms/studio/mesh:latest
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://studio:${DB_PASSWORD}@postgres:5432/studio
    ports: ["3000:3000"]
    volumes:
      - studio-data:/app/data

volumes:
  postgres_data:
  studio-data:
```

### Kubernetes (Helm)

```bash
helm install deco-studio oci://ghcr.io/decocms/chart-deco-studio \
  --version <version> -n deco-studio --create-namespace
```

## Specification

The complete design spec lives at [`spec/001.md`](./spec/001.md): MCP-native API architecture, OAuth 2.1 implementation, organization-based access control, MCP Bindings, OpenTelemetry observability, database schema, and self-hosting guide.

Product docs: [docs.decocms.com](https://docs.decocms.com/).

## License

[Deco CMS Sustainable Use License v1.1](../../LICENSE.md).

- Free to self-host for internal use
- Free for client projects (agencies, SIs)
- Commercial license required for SaaS or revenue-generating production systems

Questions: [builders@decocms.com](mailto:builders@decocms.com)

---

<p align="center">
  Built with care by the <a href="https://decocms.com">deco</a> community
</p>
