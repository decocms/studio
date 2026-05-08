# @decocms/mesh-sdk

SDK for building external apps that integrate with Studio MCP servers. Provides React hooks and utilities for managing connections, authenticating with OAuth, and calling MCP tools.

## Installation

```bash
npm install @decocms/mesh-sdk @decocms/bindings
# or
bun add @decocms/mesh-sdk @decocms/bindings
```

### Peer Dependencies

```bash
npm install react @tanstack/react-query
# Optional: for toast notifications
npm install sonner
```

## Quick Start

### 1. Create an API Key

In Studio, call the `API_KEY_CREATE` tool to create an API key with the appropriate scopes for the connections you want to access. The API key will be used to authenticate your external app.

```typescript
// Example: Create an API key via MCP
await client.callTool({
  name: "API_KEY_CREATE",
  arguments: {
    name: "My External App",
    scopes: ["connections:read", "connections:write"],
  },
});
```

### 2. Server-Side: Connect to Studio

```typescript
// server.ts (Node.js / Bun / your backend)
import { createMCPClient } from "@decocms/mesh-sdk";

// Create an MCP client - keep API key on server only!
const client = await createMCPClient({
  meshUrl: "https://mesh.your-company.com",  // Your Mesh server URL
  connectionId: "self",                       // "self" for management API
  orgId: "org_xxxxx",                         // Your organization ID
  token: process.env.MESH_API_KEY,            // API key from environment
});

// List connections
const result = await client.callTool({
  name: "COLLECTION_CONNECTIONS_LIST",
  arguments: { limit: 100 },
});
```

### 3. Client-Side: Set Up React App

```tsx
// app.tsx (React client)
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
      <Toaster />
    </QueryClientProvider>
  );
}
```

## Full Example: User Sandbox Integration

The most common use case for external apps is letting your end-users connect their own MCPs via the **User Sandbox plugin**. This creates isolated connections per user.

### Server-Side: Create a Connect Session

```typescript
// server/api.ts (Hono / Express / your backend)
import { Hono } from "hono";
import { createMCPClient } from "@decocms/mesh-sdk";

const app = new Hono();

const MESH_URL = process.env.MESH_URL!;
const ORG_ID = process.env.MESH_ORG_ID!;
const API_KEY = process.env.MESH_API_KEY!;

let meshClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;

async function getMeshClient() {
  if (!meshClient) {
    meshClient = await createMCPClient({
      meshUrl: MESH_URL,
      connectionId: "self",
      orgId: ORG_ID,
      token: API_KEY,
    });
  }
  return meshClient;
}

// POST /api/connect-session - Create a session for end-user to connect MCPs
app.post("/api/connect-session", async (c) => {
  const { userId } = await c.req.json();
  const client = await getMeshClient();

  // Call User Sandbox plugin to create a connect session
  const result = await client.callTool({
    name: "USER_SANDBOX_CREATE_SESSION",
    arguments: {
      templateId: "your-template-id",  // Created in Mesh dashboard
      externalUserId: userId,           // Your app's user ID
      redirectUrl: "https://your-app.com/connect/complete",
    },
  });

  const payload = result as { structuredContent?: { sessionUrl: string } };
  return c.json({ connectUrl: payload.structuredContent?.sessionUrl });
});

export default app;
```

### Client-Side: Redirect User to Connect

```tsx
// client/connect-button.tsx (React)

function ConnectIntegrationsButton({ userId }: { userId: string }) {
  const [isLoading, setIsLoading] = useState(false);

  const handleConnect = async () => {
    setIsLoading(true);

    // Get connect session URL from your server
    const res = await fetch("/api/connect-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const { connectUrl } = await res.json();

    // Redirect user to Mesh connect flow
    window.location.href = connectUrl;
  };

  return (
    <button
      onClick={handleConnect}
      disabled={isLoading}
      className="px-4 py-2 bg-blue-600 text-white rounded"
    >
      {isLoading ? "Loading..." : "Connect Your Apps"}
    </button>
  );
}
```

## Example: Direct MCP Tool Calls

For server-side automation or admin tasks, you can call any MCP tool directly:

```typescript
// server-side only
import { createMCPClient } from "@decocms/mesh-sdk";

const client = await createMCPClient({
  meshUrl: "https://mesh.your-company.com",
  connectionId: "self",
  orgId: process.env.ORG_ID!,
  token: process.env.MESH_API_KEY!,
});

// List Virtual MCPs (agents)
const agents = await client.callTool({
  name: "COLLECTION_VIRTUAL_MCP_LIST",
  arguments: { limit: 100 },
});

// Create a connection
const newConn = await client.callTool({
  name: "COLLECTION_CONNECTIONS_CREATE",
  arguments: {
    data: {
      title: "My MCP Server",
      url: "https://mcp.example.com/sse",
    },
  },
});

// Call a tool on a specific connection
const specificClient = await createMCPClient({
  meshUrl: "https://mesh.your-company.com",
  connectionId: "conn_xxx",  // Target connection ID
  orgId: process.env.ORG_ID!,
  token: process.env.MESH_API_KEY!,
});

const result = await specificClient.callTool({
  name: "SOME_TOOL_ON_THAT_MCP",
  arguments: { /* ... */ },
});
```

## API Reference

### `createMCPClient(options)` - Server-Side

Creates and connects an MCP client to a Studio server. **Use on server only** - don't expose your API key to the client.

```typescript
// server-side only
const client = await createMCPClient({
  meshUrl: "https://studio.example.com",  // Required for external apps
  connectionId: "self",                  // "self" for management API, or connection ID
  orgId: "org_xxx",                      // Organization ID
  token: process.env.MESH_API_KEY,       // API key from environment
});
```

### `useMCPClient(options)` - Client-Side (Same-Origin Only)

React hook version of `createMCPClient`. Uses Suspense. **Only use when running on the same origin as Studio** (e.g., inside Studio app itself).

```typescript
// client-side - only for same-origin apps
function MyComponent() {
  const client = useMCPClient({
    connectionId: "self",
    orgId: "org_xxx",
    // No token needed when using cookies on same origin
  });

  // client is ready to use
}
```

### `authenticateMcp(options)` - Client-Side

Triggers OAuth authentication flow for an MCP connection. **This runs client-side** - it doesn't expose your API key.

```typescript
// client-side - safe to use in browser
const result = await authenticateMcp({
  meshUrl: "https://studio.example.com",  // Required for external apps
  connectionId: "conn_xxx",              // Connection to authenticate
  callbackUrl: "https://your-app.com/oauth/callback",  // Your OAuth callback URL
  timeout: 120000,                       // Timeout in ms (default: 120000)
  scope: ["read", "write"],              // OAuth scopes (optional)
  windowMode: "popup",                   // "popup" (default) or "tab"
});

if (result.error) {
  console.error("Auth failed:", result.error);
} else {
  console.log("Got token:", result.token);
}
```

**Window modes:**
- `"popup"` (default): Opens OAuth in a popup window. May be blocked on some mobile devices.
- `"tab"`: Opens OAuth in a new tab. Works on all devices. Uses localStorage for cross-tab communication.

### `isConnectionAuthenticated(options)` - Server or Client

Check if a connection is authenticated. Can be used on either server or client.

```typescript
const status = await isConnectionAuthenticated({
  url: "https://studio.example.com/mcp/conn_xxx",
  token: "bearer_token",  // Optional
  meshUrl: "https://studio.example.com",  // For API calls
});

console.log(status.isAuthenticated);  // boolean
console.log(status.supportsOAuth);    // boolean
console.log(status.hasOAuthToken);    // boolean
```

### Collection Hooks - Client-Side (Same-Origin Only)

When using with `ProjectContextProvider`, you get access to collection hooks. **Only use when running on the same origin as Studio** (e.g., inside Studio app or plugins).

```typescript
// client-side - only for same-origin apps (inside Mesh)
import {
  ProjectContextProvider,
  useConnections,
  useConnection,
  useConnectionActions,
} from "@decocms/mesh-sdk";

function App() {
  return (
    <ProjectContextProvider
      org={{ id: "org_xxx", slug: "my-org", name: "My Org", logo: null }}
      project={{ slug: "org-admin" }}
    >
      <ConnectionsManager />
    </ProjectContextProvider>
  );
}

function ConnectionsManager() {
  // List all connections
  const connections = useConnections();

  // Get single connection
  const connection = useConnection("conn_xxx");

  // CRUD actions
  const { create, update, delete: remove } = useConnectionActions();

  await create.mutateAsync({
    title: "My MCP",
    url: "https://mcp.example.com",
  });
}
```

## OAuth Callback Setup - Client-Side

If you're using `authenticateMcp()` directly (not via User Sandbox plugin), you need an OAuth callback route. This is a **client-side page** that receives the OAuth authorization code:

```tsx
// pages/oauth/callback.tsx (React client-side page)
export function OAuthCallback() {
  const params = new URLSearchParams(window.location.search);

  if (window.opener) {
    window.opener.postMessage({
      type: "mcp:oauth:callback",
      success: !params.get("error"),
      code: params.get("code"),
      state: params.get("state"),
      error: params.get("error"),
    }, window.location.origin);
  }

  return <p>Authentication complete. You can close this window.</p>;
}
```

> **Note**: If you're using the User Sandbox plugin, OAuth is handled automatically in the connect flow - you don't need this callback page.

## Types

```typescript
import type {
  ConnectionEntity,
  ConnectionCreateData,
  ConnectionUpdateData,
  VirtualMCPEntity,
  VirtualMCPCreateData,
  VirtualMCPUpdateData,
} from "@decocms/mesh-sdk";
```

## License

MIT
