# MCP Mesh

> **Context Management System for AI Applications**

MCP Mesh is an open-source platform that centralizes **Model Context Protocol (MCP)** connection management for teams and organizations. It provides secure credential storage, fine-grained access control, and unified observability for AI tool orchestration.

## What is MCP Mesh?

When AI assistants use tools via the Model Context Protocol, managing connections across a team becomes challenging:

- **Connection sprawl**: Each MCP service has its own auth, config, and credentials
- **Credential sharing**: Sharing access means sharing passwords or API keys
- **No audit trail**: Who called which tool, when, and with what result?
- **Tool isolation**: MCP services can't compose or share dependencies

MCP Mesh solves these problems by acting as a **secure proxy** between AI clients and MCP services:

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│   MCP Mesh   │────▶│  Gmail MCP      │
│  Cursor Agent   │     │   (Proxy)    │     │  Slack MCP      │
│  Custom Client  │     │              │────▶│  GitHub MCP     │
└─────────────────┘     └──────────────┘     └─────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │ - Authentication   │
                    │ - Authorization    │
                    │ - Credential Vault │
                    │ - Audit Logging    │
                    │ - Observability    │
                    └────────────────────┘
```

## Features

### ✅ Implemented

- **Organization Management** — Create orgs, invite members, assign roles
- **Connection Registry** — Register and manage MCP connections
- **Secure Credential Vault** — AES-256-GCM encrypted credential storage
- **MCP Proxy** — Proxy requests to downstream MCPs with credential injection
- **OAuth 2.1 Server** — Full MCP OAuth spec compliance (PKCE, Dynamic Client Registration)
- **Management Tools via MCP** — All admin operations exposed as MCP tools
- **Web Dashboard** — React UI for managing orgs, connections, and members
- **Multi-DB Support** — SQLite (default), PostgreSQL, MySQL via Kysely
- **OpenTelemetry** — Distributed tracing and Prometheus metrics
- **Magic Link Auth** — Passwordless authentication via email
- **SSO Support** — Google, GitHub, and SAML providers

### 🚧 Planned

- [ ] MCP Bindings (protocol-level interfaces for tool abstraction)
- [ ] Tool composition across connections
- [ ] Webhook events
- [ ] CLI tool

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)

### Run Locally (Zero Config)

```bash
# Clone the repository
git clone https://github.com/deco-cx/admin.git
cd admin/apps/mesh

# Install dependencies
bun install

# Run database migrations
bun run migrate

# Start the server
bun run dev
```

### Run with NATS (Optional)

By default, the event bus uses polling to wake up workers. For lower latency and better multi-replica coordination, you can run a local [NATS](https://nats.io) server instead.

**Install nats-server:**

```bash
# macOS
brew install nats-server

# Other platforms — see https://docs.nats.io/running-a-nats-service/introduction/installation
```

**Start NATS:**

```bash
nats-server
```

**Add to your `.env` file:**

```bash
NATS_URL=nats://localhost:4222
```

When `NATS_URL` is set, mesh automatically switches to the NATS notify strategy. Polling remains active as a safety net.

---

The server starts at `http://localhost:3000` with:
- 📋 Health check: `http://localhost:3000/health`
- 🔐 Auth endpoints: `http://localhost:3000/api/auth/*`
- 🔧 MCP endpoint: `http://localhost:3000/mcp`
- 📊 Metrics: `http://localhost:3000/metrics`

A SQLite database is automatically created at `./data/mesh.db`.

## Architecture

### Project Structure

```
apps/mesh/
├── src/
│   ├── api/                    # Hono HTTP server
│   │   ├── routes/
│   │   │   ├── auth.ts         # Custom auth endpoints
│   │   │   ├── management.ts   # MCP management server
│   │   │   ├── models.ts       # LLM provider routing
│   │   │   └── proxy.ts        # MCP proxy server
│   │   └── utils/
│   │       └── mcp.ts          # MCP server builder
│   │
│   ├── auth/                   # Better Auth configuration
│   │   ├── index.ts            # Auth instance
│   │   ├── jwt.ts              # JWT utilities
│   │   ├── oauth-providers.ts  # Social login providers
│   │   └── sso.ts              # SAML SSO
│   │
│   ├── core/                   # Core abstractions
│   │   ├── access-control.ts   # Permission checking
│   │   ├── context-factory.ts  # MeshContext factory
│   │   ├── define-tool.ts      # Tool definition helper
│   │   └── mesh-context.ts     # Request context type
│   │
│   ├── database/               # Kysely database setup
│   ├── encryption/             # Credential vault (AES-256-GCM)
│   ├── observability/          # OpenTelemetry setup
│   ├── storage/                # Database adapters
│   │
│   ├── tools/                  # MCP management tools
│   │   ├── connection/         # CONNECTION_* tools
│   │   ├── organization/       # ORGANIZATION_* tools
│   │   └── database/           # DATABASE_* tools
│   │
│   └── web/                    # React frontend
│       ├── components/
│       ├── hooks/
│       ├── layouts/
│       ├── providers/
│       └── routes/
│
├── migrations/                 # Kysely migrations
├── spec/                       # Design specifications
│   └── 001.md                  # Full mesh spec
└── data/                       # SQLite database (gitignored)
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Server | Hono |
| Database | Kysely (SQLite/PostgreSQL/MySQL) |
| Auth | Better Auth (+ MCP, API Key, Organization plugins) |
| Frontend | React 19, TanStack Router, TanStack Query |
| Styling | Tailwind CSS v4 |
| MCP | @modelcontextprotocol/sdk |
| Observability | OpenTelemetry, Prometheus |

## API Reference

### MCP Endpoints

#### Management API (`/mcp`)

Exposes organization and connection management tools via MCP protocol:

```bash
# List tools
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Available Tools:**

| Tool | Description |
|------|-------------|
| `ORGANIZATION_CREATE` | Create a new organization |
| `ORGANIZATION_LIST` | List user's organizations |
| `ORGANIZATION_GET` | Get organization details |
| `ORGANIZATION_UPDATE` | Update organization |
| `ORGANIZATION_DELETE` | Delete organization |
| `ORGANIZATION_MEMBER_ADD` | Add member to organization |
| `ORGANIZATION_MEMBER_REMOVE` | Remove member |
| `ORGANIZATION_MEMBER_LIST` | List members |
| `ORGANIZATION_MEMBER_UPDATE_ROLE` | Update member role |
| `COLLECTION_CONNECTIONS_CREATE` | Register MCP connection |
| `COLLECTION_CONNECTIONS_LIST` | List connections |
| `COLLECTION_CONNECTIONS_GET` | Get connection details |
| `COLLECTION_CONNECTIONS_UPDATE` | Update connection |
| `COLLECTION_CONNECTIONS_DELETE` | Delete connection |
| `CONNECTION_TEST` | Test connection health |
| `CONNECTION_CONFIGURE` | Configure connection |

#### Proxy API (`/mcp/:connectionId`)

Proxies requests to downstream MCP services:

```bash
# Call a tool on a connected MCP service
curl -X POST http://localhost:3000/mcp/conn_abc123 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"SEND_EMAIL","arguments":{...}},"id":1}'
```

The proxy:
1. Validates your token
2. Checks permissions for the tool
3. Retrieves and decrypts the connection's credentials
4. Forwards the request with proper auth
5. Logs the request to audit trail

### OAuth Discovery

MCP Mesh implements the full MCP OAuth specification:

```bash
# Protected Resource Metadata
GET /.well-known/oauth-protected-resource

# Authorization Server Metadata  
GET /.well-known/oauth-authorization-server

# Dynamic Client Registration
POST /api/auth/register
```

## Configuration

### Environment Variables

```bash
# Database (optional - defaults to SQLite)
DATABASE_URL=postgresql://user:pass@host:5432/mesh

# Server port (optional - defaults to 3000)
PORT=3000

# Encryption key for credential vault (auto-generated if not set)
ENCRYPTION_KEY=your-32-byte-key
```

### Auth Configuration

Create `auth-config.json` for custom auth providers:

```json
{
  "emailAndPassword": {
    "enabled": true
  },
  "socialProviders": {
    "google": {
      "clientId": "your-google-client-id",
      "clientSecret": "your-google-client-secret"
    },
    "github": {
      "clientId": "your-github-client-id",
      "clientSecret": "your-github-client-secret"
    }
  },
  "magicLinkConfig": {
    "enabled": true,
    "emailProviderId": "resend-primary"
  },
  "emailProviders": [
    {
      "id": "resend-primary",
      "provider": "resend",
      "config": {
        "apiKey": "your-resend-api-key",
        "fromEmail": "noreply@yourdomain.com"
      }
    }
  ]
}
```

See `auth-config.example.json` for a complete example.

## Development

### Scripts

```bash
# Development (hot reload)
bun run dev

# Run tests
bun run test

# Type check
bun run check

# Build for production
bun run build:client
bun run build:server

# Run production build
bun run start

# Database migrations
bun run migrate
bun run better-auth:migrate  # Better Auth tables
```

### Testing

Tests use Bun's built-in test runner:

```bash
# Run all tests
bun test

# Run specific test file
bun test src/core/access-control.test.ts

# Watch mode
bun test --watch
```

## Deployment

### Docker

```dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:client && bun run build:server

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
CMD ["bun", "run", "dist/server/server.js"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  mesh:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
      - ./auth-config.json:/app/auth-config.json
    environment:
      - NODE_ENV=production
```

### With PostgreSQL

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: mesh
      POSTGRES_USER: mesh
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data

  mesh:
    build: .
    depends_on:
      - postgres
    environment:
      DATABASE_URL: postgresql://mesh:${DB_PASSWORD}@postgres:5432/mesh
    ports:
      - "3000:3000"

volumes:
  postgres_data:
```

## Specification

For the complete technical specification, see [`spec/001.md`](./spec/001.md).

Key topics covered:
- MCP-native API architecture
- OAuth 2.1 implementation (Authorization Server, Resource Server, Client)
- Organization-based access control
- MCP Bindings concept
- OpenTelemetry observability
- Database schema design
- Self-hosting guide

## Contributing

We welcome contributions! Please see our [Contributing Guide](../../CONTRIBUTING.md).

### Development Setup

1. Fork and clone the repository
2. Install dependencies: `bun install`
3. Start development server: `bun run dev`
4. Make changes and add tests
5. Submit a pull request

## License

MIT License - see [LICENSE](../../LICENSE.md) for details.

---

<p align="center">
  Built with 💚 by <a href="https://decocms.com">decocms.com</a>
</p>

