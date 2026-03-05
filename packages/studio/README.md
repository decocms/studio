# Deco Studio

Open-source control plane for your AI agents. Install in 30 seconds.

```bash
npx decocms
```

Or install globally:

```bash
npm i -g decocms
deco
```

## What is Deco Studio?

Deco Studio is where you hire AI agents, connect tools, and manage projects —
all from a single dashboard. Browse specialized agents, wire up 50+ integrations
via MCP, and track every token, cost, and action in real time.

- **Hire agents** — browse specialized AI agents or create your own from custom prompts. Agents can compose and call each other.
- **Connect tools** — 50+ integrations (GitHub, Slack, Postgres, OpenAI, and more) with one-click OAuth and granular RBAC.
- **Track everything** — real-time cost attribution, latency monitoring, and error tracking per agent and connection.
- **Run locally** — private, SQLite-based setup on your machine. No cloud required.
- **Scale to teams** — optional cloud sync via [studio.decocms.com](https://studio.decocms.com), or self-host for your org.

```
Your AI Agents & MCP Clients
              │
              ▼
        Deco Studio
  Agents · Tools · Observability
              │
              ▼
 Integrations (Slack, GitHub, APIs, DBs...)
```

## Quick start

```bash
# Start Deco Studio locally
npx decocms

# Opens at http://localhost:3000
```

Connect any MCP client to `http://localhost:3000/mcp`:

```json
{
  "mcpServers": {
    "deco": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Deploy

Run locally with SQLite, or deploy for your team with Docker, Bun/Node,
Kubernetes, and PostgreSQL. See the [docs](https://docs.deco.page/).

## Links

- [Website](https://decocms.com/studio)
- [Documentation](https://docs.deco.page/)
- [GitHub](https://github.com/decocms/mesh)
- [Discord](https://decocms.com/discord)

## License

Sustainable Use License — free to self-host for internal use and client
projects. See [LICENSE.md](https://github.com/decocms/mesh/blob/main/LICENSE.md).
