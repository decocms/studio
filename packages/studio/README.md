# Deco Studio

One secure endpoint for every MCP server — run locally in seconds.

```bash
npx decocms
```

Or install globally:

```bash
npm i -g decocms
deco
```

## What is this?

Deco Studio (powered by [MCP Mesh](https://github.com/decocms/mesh)) is an
open-source control plane for Model Context Protocol (MCP) traffic. It sits
between your MCP clients (Cursor, Claude, Windsurf, VS Code, custom agents) and
your MCP servers, providing a unified layer for auth, routing, and observability.

```
MCP Clients (Cursor, Claude, VS Code, agents)
                    │
                    ▼
              Deco Studio
    Virtual MCPs · Policies · Traces · Vault
                    │
                    ▼
MCP Servers (Slack, GitHub, Postgres, your APIs)
```

## Features

- **Single endpoint** — replace M x N client/server configs with one governed URL
- **RBAC & policies** — workspace and project-level access control with audit trails
- **Full observability** — OpenTelemetry tracing, cost tracking, error monitoring
- **Virtual MCPs** — runtime strategies for optimal tool selection (full-context, smart selection, code execution)
- **Token vault** — secure credential storage for MCP server connections
- **Local-first** — runs on your machine with SQLite, no cloud required
- **OAuth built-in** — connect to OAuth-protected MCP servers with one click
- **AI chat** — built-in chat UI with multi-provider support (OpenRouter, OpenAI, Anthropic, etc.)

## Quick start

```bash
# Start Deco Studio locally
npx decocms

# Opens at http://localhost:3000
# Connect your MCP clients to http://localhost:3000/mcp
```

Point any MCP client at `http://localhost:3000/mcp` and all your MCP servers
are available through a single endpoint.

## Connect MCP clients

### Cursor / Claude Desktop / VS Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "deco": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Self-host in production

For team and production deployments, see the
[full documentation](https://docs.deco.page/) — supports Docker, Bun/Node,
Kubernetes, and PostgreSQL.

## Links

- [Documentation](https://docs.deco.page/)
- [GitHub](https://github.com/decocms/mesh)
- [Discord](https://decocms.com/discord)
- [Website](https://decocms.com/mesh)

## License

Sustainable Use License (SUL) — free to self-host for internal use and client
projects. See [LICENSE.md](https://github.com/decocms/mesh/blob/main/LICENSE.md).
