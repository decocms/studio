<h1 align="center">deco Studio</h1>

<p align="center">
<em>Open-source · TypeScript-first · Deploy anywhere</em><br/><br/>
<b>Open-source control plane for your AI agents.</b>
</p>

<p align="center">
<a href="https://docs.deco.page/">Docs</a> ·
<a href="https://decocms.com/discord">Discord</a> ·
<a href="https://decocms.com/studio">decocms.com/studio</a>
</p>

> **TL;DR:** Hire agents with real skills. Connect your tools with one-click OAuth. Track every token and dollar. Control everything from any browser. Self-host or use the cloud.

---

## What is deco Studio?

Studio is where you manage your AI agents, tools, and projects — all from one place.

Instead of wiring up MCP servers one by one across every client, you connect them once in Studio and get a single endpoint that any client can use. But connections are just the start: Studio adds agents that know how to use those tools, projects with declarative planning, per-connection cost tracking, and a web dashboard you can access from anywhere.

Install locally and everything stays private. Optionally sync to the cloud for remote access, team roles, and shared billing.

```
┌─────────────────────────────────────────────────────────────────┐
│                           Clients                               │
│         Cursor · Claude · VS Code · Custom Agents               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                        DECO STUDIO                              │
│  Agents · Connections · Projects · Observability · Token Vault  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Tools & MCP Servers                          │
│      GitHub · Slack · Postgres · OpenRouter · Your APIs         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
bunx decocms
```

Or clone and run from source:

```bash
git clone https://github.com/decocms/studio.git
bun install
bun run dev
```

> runs at [http://localhost:3000](http://localhost:3000) (client) + API server

---

## What you get

### Agents

Browse and hire specialized AI agents from the built-in store. Each agent comes with battle-tested prompts and knows how to use specific tools. Agents compose — they can call each other — and every action is tracked with cost attribution.

### Connections

Set up MCP connections through a web UI with one-click OAuth. No JSON configs. Monitor latency, errors, and costs per connection. Share tools across your team without sharing credentials.

As tool surfaces grow, Studio exposes **Virtual MCPs** — one endpoint, different strategies for which tools to surface:

- **Full-context:** expose everything (simple, deterministic, good for small toolsets)
- **Smart selection:** narrow the toolset before execution
- **Code execution:** load tools on demand in a sandbox

### Projects

Define what done looks like. Studio works backward to derive milestones, assign agents, and verify outcomes.

### Observability

See token spend per connection — OpenRouter, Perplexity, Firecrawl, all of it. Latency, errors, bottlenecks. One dashboard.

### From your laptop to your org

Same mental model everywhere: your agents, your tools, your connections, your projects.

| | What it means |
|---|---|
| **Local** | `bunx decocms` on your laptop. SQLite. Private. |
| **Cloud** | Log in to studio.decocms.com. Control local projects from any browser. |
| **Team** | Invite people. Roles. Shared connections. Cost attribution. |
| **Enterprise** | Self-hosted. Your infra. Your rules. |

---

## Core Capabilities

| Capability | What it does |
|---|---|
| **Agents** | Browse, hire, and compose AI agents with tracked skills and cost attribution |
| **Connections** | Route MCP traffic through one governed endpoint with auth, proxy, and token vault |
| **Projects** | Declarative planning — define outcomes, Studio derives milestones and assigns agents |
| **Virtual MCPs** | Compose and expose governed toolsets as new MCP endpoints |
| **Observability** | Full tracing and metrics — traces, costs, errors, latency per connection |
| **Access Control** | Fine-grained RBAC via Better Auth — OAuth 2.1 + API keys per workspace/project |
| **Multi-tenancy** | Workspace/project isolation for config, credentials, policies, and audit logs |
| **Event Bus** | Pub/sub between connections with scheduled/cron delivery and at-least-once guarantees |
| **Bindings** | Capability contracts so tools target interfaces, not specific implementations |
| **Store** | Discover and install agents, tools, and templates from the marketplace |

---

## Define Tools

Tools are first-class citizens. Type-safe, audited, observable, and callable via MCP.

```ts
import { z } from "zod";
import { defineTool } from "~/core/define-tool";

export const CONNECTION_CREATE = defineTool({
  name: "CONNECTION_CREATE",
  description: "Create a new MCP connection",
  inputSchema: z.object({
    name: z.string(),
    connection: z.object({
      type: z.enum(["HTTP", "SSE", "WebSocket"]),
      url: z.string().url(),
      token: z.string().optional(),
    }),
  }),
  outputSchema: z.object({
    id: z.string(),
    scope: z.enum(["workspace", "project"]),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const conn = await ctx.storage.connections.create({
      projectId: ctx.project?.id ?? null,
      ...input,
      createdById: ctx.auth.user!.id,
    });
    return { id: conn.id, scope: conn.projectId ? "project" : "workspace" };
  },
});
```

Every tool call automatically gets: input/output validation, access control checks, audit logging, and OpenTelemetry traces.

---

## Project Structure

```
├── apps/
│   ├── mesh/                # Full-stack deco Studio (Hono API + Vite/React)
│   │   ├── src/
│   │   │   ├── api/         # Hono HTTP + MCP proxy routes
│   │   │   ├── auth/        # Better Auth (OAuth + API keys)
│   │   │   ├── core/        # MeshContext, AccessControl, defineTool
│   │   │   ├── tools/       # Built-in MCP management tools
│   │   │   ├── storage/     # Kysely DB adapters
│   │   │   ├── event-bus/   # Pub/sub event delivery system
│   │   │   ├── encryption/  # Token vault & credential management
│   │   │   ├── observability/  # OpenTelemetry tracing & metrics
│   │   │   └── web/         # React 19 admin UI
│   │   └── migrations/      # Kysely database migrations
│   └── docs/                # Astro documentation site
│
└── packages/
    ├── bindings/            # Core MCP bindings and connection abstractions
    ├── runtime/             # MCP proxy, OAuth, and runtime utilities
    ├── ui/                  # Shared React components (shadcn-based)
    ├── cli/                 # CLI tooling (deco commands)
    ├── create-deco/         # Project scaffolding (npm create deco)
    └── vite-plugin-deco/    # Vite plugin for Deco projects
```

---

## Development

```bash
# Install dependencies
bun install

# Run dev server (client + API)
bun run dev

# Run tests
bun test

# Type check
bun run check

# Lint
bun run lint

# Format
bun run fmt
```

### Studio-specific commands (from `apps/mesh/`)

```bash
bun run dev:client     # Vite dev server (port 4000)
bun run dev:server     # Hono server with hot reload
bun run migrate        # Run database migrations
```

### Running with worktrees (subdomain per workspace)

`dev:worktree` routes `http://<WORKTREE_SLUG>.localhost` to the dev server via Caddy. Useful for running multiple workspaces in parallel without port conflicts.

**One-time setup:**

```bash
brew install caddy
caddy start
```

**Start dev server for a worktree:**

```bash
WORKTREE_SLUG=my-feature bun run dev:worktree
# → http://my-feature.localhost is live
```

Ports for Hono and Vite are allocated automatically. On exit (Ctrl+C) the route is removed and ports are freed. State is tracked in `~/.worktree-devservers/proxy-map.json`.

**Conductor adapter** (sets `WORKTREE_SLUG` from `CONDUCTOR_WORKSPACE_NAME` automatically):

```bash
bun run dev:conductor
```

---

## Deploy Anywhere

```bash
# Docker Compose (SQLite)
docker compose -f deploy/docker-compose.yml up

# Docker Compose (PostgreSQL)
docker compose -f deploy/docker-compose.postgres.yml up

# Self-host with Bun
bun run build:client && bun run build:server
bun run start

# Kubernetes
kubectl apply -f k8s/
```

Runs on any infrastructure — Docker, Kubernetes, AWS, GCP, or local Bun/Node runtimes. No vendor lock-in.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Bun / Node |
| Language | TypeScript + Zod |
| Framework | Hono (API) + Vite + React 19 |
| Database | Kysely → SQLite / PostgreSQL |
| Auth | Better Auth (OAuth 2.1 + API keys) |
| Observability | OpenTelemetry |
| UI | React 19 + Tailwind v4 + shadcn |
| Protocol | Model Context Protocol (MCP) |

---

## Roadmap

- [ ] Agent marketplace — discover, hire, and compose agents
- [ ] Declarative planning engine
- [ ] Cost analytics and spend caps
- [ ] Remote access from any browser
- [ ] Live tracing debugger
- [ ] Version history for configs
- [ ] Workflow orchestration with guardrails

---

## License

deco Studio ships with a **Sustainable Use License (SUL)**. See [LICENSE.md](./LICENSE.md).

- Free to self-host for internal use
- Free for client projects (agencies, SIs)
- Commercial license required for SaaS or revenue-generating production systems

Questions? [contact@decocms.com](mailto:contact@decocms.com)

---

## Contributing

We welcome contributions! Run the following before submitting a PR:

```bash
bun run fmt      # Format code
bun run lint     # Check linting
bun test         # Run tests
```

See `AGENTS.md` for detailed coding guidelines and conventions.

---

<div align="center">
  <sub>Made with care by the <a href="https://decocms.com">deco</a> community</sub>
</div>
