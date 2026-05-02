<h1 align="center">deco Studio</h1>

<p align="center">
<em>Open-source · TypeScript-first · Deploy anywhere</em><br/><br/>
<b>Open-source control plane for your AI agents.</b>
</p>

<p align="center">
<a href="https://docs.decocms.com/">Docs</a> ·
<a href="https://decocms.com/discord">Discord</a> ·
<a href="https://decocms.com/studio">decocms.com/studio</a>
</p>

> **TL;DR:** Hire agents. Connect tools. Organize them into projects with a UI that fits the job. Track every token and dollar. Self-host or use the cloud.

---

## What is deco Studio?

Studio is where you hire agents, connect tools, and organize them into projects that actually do things.

Agents come with real skills and battle-tested prompts. Connections give them access to your tools — GitHub, Slack, Postgres, OpenRouter, anything that speaks MCP — set up through a web UI with one-click OAuth. Projects bring agents and connections together around a goal: each project gets its own sidebar and UI, shaped by what's inside it.

Everything is tracked — tokens, costs, errors, latency — per connection, per agent. Install locally and it stays private. Sync to the cloud for remote access, team roles, and shared billing.

```
┌─────────────────────────────────────────────────────────────────┐
│                           Clients                               │
│         Cursor · Claude · VS Code · Custom Agents               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         deco Studio                             │
│  Agents · Connections · Projects · Observability · Token Vault  │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Tools & MCP Servers                         │
│      GitHub · Slack · Postgres · OpenRouter · Your APIs         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

```bash
bunx decostudio
```

Runs at [http://localhost:3000](http://localhost:3000) with embedded PostgreSQL. Private by default, no signup required.

```bash
# Custom port
bunx decostudio -p 8080

# Custom data directory
bunx decostudio --home ~/my-project

# Dev mode (Vite hot reload)
bunx decostudio dev

# Scaffold a new MCP app
bunx decostudio init my-app

# Manage local services (Postgres, NATS)
bunx decostudio services up
```

---

## What you get

### Agents

Browse and hire specialized AI agents from the built-in store. Each agent knows how to use specific tools and comes with battle-tested prompts. Agents compose — they can call each other — and every action is tracked with cost attribution.

### Connections

Set up MCP connections through a web UI with one-click OAuth. No JSON configs. Monitor latency, errors, and costs per connection. Share tools across your team without sharing credentials.

As tool surfaces grow, Studio exposes **Virtual MCPs** — one endpoint, different strategies for which tools to surface:

- **Full-context:** expose everything (simple, deterministic, good for small toolsets)
- **Smart selection:** narrow the toolset before execution
- **Code execution:** load tools on demand in a sandbox

### Projects

Projects bring agents and connections together around a goal. The project's UI adapts to what's inside — add a content agent and a CMS connection, the sidebar shows content management; add an analytics agent and a database, it shows dashboards and queries. The UI you see is the UI that's relevant for operating that project.

You can also define outcomes declaratively and let Studio work backward to derive milestones, assign agents, and verify results.

### Observability

Token spend per connection — OpenRouter, Perplexity, Firecrawl, all of it. Latency, errors, bottlenecks. One dashboard.

### From your laptop to your org

| | |
|---|---|
| **Local** | `bunx decostudio` on your laptop. Embedded PostgreSQL. Private. |
| **Cloud** | Log in to studio.decocms.com. Control local projects from any browser. |
| **Team** | Invite people. Roles. Shared connections. Cost attribution. |
| **Enterprise** | Self-hosted. Your infra. Your rules. |

---

## Core Capabilities

| Capability | What it does |
|---|---|
| **Agents** | Browse, hire, and compose AI agents with tracked skills and cost attribution |
| **Connections** | Route MCP traffic through one governed endpoint with auth, proxy, and token vault |
| **Projects** | Organize agents and connections around goals with an adaptive UI |
| **Virtual MCPs** | Compose and expose governed toolsets as new MCP endpoints |
| **Observability** | Traces, costs, errors, and latency per connection — one dashboard |
| **Access Control** | RBAC via Better Auth — OAuth 2.1 + API keys per workspace/project |
| **Multi-tenancy** | Workspace/project isolation for config, credentials, policies, and audit logs |
| **Event Bus** | Pub/sub between connections with scheduled/cron delivery and at-least-once guarantees |
| **Bindings** | Capability contracts so tools target interfaces, not specific implementations |
| **Store** | Discover and install agents, tools, and templates |

---

## Define Tools

Type-safe, audited, observable, callable via MCP.

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

Every tool call gets input/output validation, access control, audit logging, and OpenTelemetry traces automatically.

---

## Deploy Anywhere

```bash
# Docker (embedded PostgreSQL)
docker run -p 3000:3000 -v studio-data:/app/data ghcr.io/decocms/studio/mesh:latest

# Bun (from source)
git clone https://github.com/decocms/studio.git
cd studio && bun install
bun run --cwd=apps/mesh build:client
bun run --cwd=apps/mesh build:server
bun run --cwd=apps/mesh start

# Kubernetes (Helm)
helm install deco-studio oci://ghcr.io/decocms/chart-deco-studio \
  --version <version> -n deco-studio --create-namespace
```

No vendor lock-in. Runs on Docker, Kubernetes, AWS, GCP, or local runtimes.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Bun / Node |
| Language | TypeScript + Zod |
| Framework | Hono (API) + Vite + React 19 |
| Database | Kysely → embedded PostgreSQL / PostgreSQL |
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
- [ ] Workflow orchestration with guardrails

---

## License

**Sustainable Use License (SUL)** — see the [project repository](https://github.com/decocms/studio) for full terms.

- Free to self-host for internal use
- Free for client projects (agencies, SIs)
- Commercial license required for SaaS or revenue-generating production systems

Questions? [builders@decocms.com](mailto:builders@decocms.com)

---

<div align="center">
  <sub>Made with care by the <a href="https://decocms.com">deco</a> community</sub>
</div>
