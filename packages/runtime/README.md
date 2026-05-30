# @decocms/runtime

A TypeScript framework for building MCP (Model Context Protocol) servers with first-class support for tools, prompts, resources, OAuth authentication, and event-driven architectures.

## Installation

```bash
bun add @decocms/runtime
```

Or with npm:

```bash
npm install @decocms/runtime
```

## Quick Start

Create a simple MCP server with tools:

```typescript
import { withRuntime, createTool } from "@decocms/runtime";
import { z } from "zod";

// Define a tool
const greetTool = createTool({
  id: "greet",
  description: "Greets a user by name",
  inputSchema: z.object({
    name: z.string().describe("Name of the person to greet"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  execute: async ({ context }) => {
    return { message: `Hello, ${context.name}!` };
  },
});

// Create the MCP server
export default withRuntime({
  tools: [greetTool],
});
```

The server automatically exposes an MCP endpoint at `/mcp` that handles all MCP protocol requests.

## Core Concepts

### withRuntime

The `withRuntime` function is the main entry point for creating an MCP server. It accepts configuration options and returns a fetch handler compatible with Cloudflare Workers, Bun, and other web standard runtimes.

```typescript
import { withRuntime } from "@decocms/runtime";

export default withRuntime({
  // Tools exposed to LLMs
  tools: [...],
  
  // Prompts for guided interactions
  prompts: [...],
  
  // Resources for data access
  resources: [...],
  
  // Optional: Custom fetch handler for non-MCP routes
  fetch: async (req, env, ctx) => {
    // Handle custom routes
    return new Response("Custom response");
  },
  
  // Optional: CORS configuration
  cors: {
    origin: "*",
    credentials: true,
  },
  
  // Optional: OAuth configuration
  oauth: { ... },
  
  // Optional: Configuration state
  configuration: { ... },
  
  // Optional: Event handlers
  events: { ... },
  
  // Optional: Hook before request processing
  before: async (env) => {
    // Initialize resources
  },
});
```

## Tools

Tools are functions that LLMs can invoke to perform actions or retrieve data.

### Creating a Tool

```typescript
import { createTool } from "@decocms/runtime";
import { z } from "zod";

const calculateTool = createTool({
  id: "calculate",
  description: "Performs basic arithmetic operations",
  inputSchema: z.object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    a: z.number(),
    b: z.number(),
  }),
  outputSchema: z.object({
    result: z.number(),
  }),
  execute: async ({ context }) => {
    const { operation, a, b } = context;
    let result: number;
    
    switch (operation) {
      case "add": result = a + b; break;
      case "subtract": result = a - b; break;
      case "multiply": result = a * b; break;
      case "divide": result = a / b; break;
    }
    
    return { result };
  },
});
```

### Private Tools (Authentication Required)

Use `createPrivateTool` for tools that require user authentication:

```typescript
import { createPrivateTool } from "@decocms/runtime";

const getUserDataTool = createPrivateTool({
  id: "getUserData",
  description: "Retrieves the current user's data",
  inputSchema: z.object({}),
  outputSchema: z.object({
    userId: z.string(),
    email: z.string(),
  }),
  execute: async ({ runtimeContext }) => {
    // ensureAuthenticated is called automatically
    const user = runtimeContext.env.MESH_REQUEST_CONTEXT.ensureAuthenticated();
    return { userId: user.id, email: user.email };
  },
});
```

### Registering Tools

Pass an array of tool instances created with `createTool()` / `createPrivateTool()`:

```typescript
export default withRuntime({
  tools: [greetTool, calculateTool],
});
```

## Prompts

Prompts define guided interactions with predefined templates.

### Creating a Prompt

```typescript
import { createPrompt, createPublicPrompt } from "@decocms/runtime";
import { z } from "zod";

const codeReviewPrompt = createPrompt({
  name: "code-review",
  title: "Code Review",
  description: "Provides a structured code review",
  argsSchema: {
    code: z.string().describe("The code to review"),
    language: z.string().optional().describe("Programming language"),
  },
  execute: async ({ args }) => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please review this ${args.language ?? "code"}:\n\n${args.code}`,
          },
        },
      ],
    };
  },
});

// Public prompt (no auth required)
const welcomePrompt = createPublicPrompt({
  name: "welcome",
  title: "Welcome Message",
  description: "Generates a welcome message",
  execute: async () => {
    return {
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Welcome to our MCP server!" },
        },
      ],
    };
  },
});
```

## Resources

Resources expose data that LLMs can read.

### Creating a Resource

```typescript
import { createResource, createPublicResource } from "@decocms/runtime";

const configResource = createResource({
  uri: "config://app",
  name: "App Configuration",
  description: "Current application configuration",
  mimeType: "application/json",
  read: async ({ runtimeContext }) => {
    const config = await loadConfig();
    return {
      uri: "config://app",
      mimeType: "application/json",
      text: JSON.stringify(config, null, 2),
    };
  },
});

// URI templates for dynamic resources
const fileResource = createPublicResource({
  uri: "file://{path}",
  name: "File Reader",
  description: "Reads file contents",
  read: async ({ uri }) => {
    const path = uri.pathname;
    const content = await readFile(path);
    return {
      uri: uri.toString(),
      mimeType: "text/plain",
      text: content,
    };
  },
});
```

## OAuth Authentication

Enable OAuth for protected MCP endpoints:

```typescript
import { withRuntime, type OAuthConfig } from "@decocms/runtime";

const oauthConfig: OAuthConfig = {
  mode: "PKCE",
  
  // External OAuth provider URL
  authorizationServer: "https://your-oauth-provider.com",
  
  // Generate authorization URL
  authorizationUrl: (callbackUrl) => {
    const url = new URL("https://your-oauth-provider.com/authorize");
    url.searchParams.set("client_id", "your-client-id");
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    return url.toString();
  },
  
  // Exchange authorization code for tokens
  exchangeCode: async ({ code, redirect_uri }) => {
    const response = await fetch("https://your-oauth-provider.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect_uri!,
        client_id: "your-client-id",
        client_secret: "your-client-secret",
      }),
    });
    return response.json();
  },
  
  // Optional: Refresh token support
  refreshToken: async (refreshToken) => {
    const response = await fetch("https://your-oauth-provider.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    return response.json();
  },
};

export default withRuntime({
  oauth: oauthConfig,
  tools: [...],
});
```

OAuth endpoints are automatically exposed:
- `/.well-known/oauth-protected-resource` - Resource metadata
- `/.well-known/oauth-authorization-server` - Server metadata
- `/authorize` - Authorization endpoint
- `/oauth/callback` - OAuth callback
- `/token` - Token endpoint
- `/register` - Dynamic client registration

## Configuration State

Define typed configuration state that persists across requests:

```typescript
import { withRuntime, BindingOf } from "@decocms/runtime";
import { z } from "zod";

// Define your state schema
const stateSchema = z.object({
  apiKey: z.string(),
  maxTokens: z.number().default(1000),
  // Bindings reference other MCP connections
  database: BindingOf<MyRegistry, "@deco/database">("@deco/database"),
});

export default withRuntime({
  configuration: {
    state: stateSchema,
    scopes: ["API_KEY::read", "DATABASE::query"],
    
    // Called when configuration changes
    onChange: async (env, { state, scopes }) => {
      console.log("Configuration updated:", state);
    },
  },
  
  tools: [
    createTool({
      id: "query",
      inputSchema: z.object({ sql: z.string() }),
      execute: async ({ context, runtimeContext }) => {
        // Access resolved bindings from state
        const { database } = runtimeContext.env.MESH_REQUEST_CONTEXT.state;
        return database.QUERY({ sql: context.sql });
      },
    }),
  ],
});
```

## Event Handlers

Subscribe to events from other MCP connections:

```typescript
import { withRuntime, SELF } from "@decocms/runtime";

export default withRuntime({
  configuration: {
    state: z.object({
      database: BindingOf<Registry, "@deco/database">("@deco/database"),
    }),
  },
  
  events: {
    // Subscribe to events from the database binding
    database: {
      // Per-event handlers
      "record.created": async ({ events }, env) => {
        for (const event of events) {
          console.log("New record:", event.data);
        }
        return { success: true };
      },
      "record.deleted": async ({ events }, env) => {
        return { success: true };
      },
    },
    
    // Subscribe to events from self (this connection)
    SELF: {
      "order.completed": async ({ events }, env) => {
        return { success: true };
      },
    },
  },
});

// Or use batch handlers for multiple event types
export default withRuntime({
  events: {
    handler: async ({ events }, env) => {
      // Process all events in batch
      return { success: true };
    },
    events: [
      "SELF::order.created",
      "database::record.updated",
    ],
  },
});
```

## Bindings

Bindings define standardized interfaces that MCP servers can implement.

### Using Existing Bindings

```typescript
import { impl, WellKnownBindings } from "@decocms/runtime/bindings";

// Implement a channel binding
const channelTools = impl(WellKnownBindings.Channel, [
  {
    description: "Join a channel",
    handler: async ({ workspace, channelId }) => {
      // Implementation
      return { success: true, channelId };
    },
  },
  {
    description: "Leave a channel",
    handler: async ({ channelId }) => {
      return { success: true };
    },
  },
]);

export default withRuntime({
  tools: channelTools,
});
```

### Creating Custom Bindings

```typescript
import { z } from "zod";
import type { Binder } from "@decocms/runtime/bindings";

// Define your binding schema
export const MY_BINDING = [
  {
    name: "MY_TOOL_ACTION" as const,
    inputSchema: z.object({
      param: z.string(),
    }),
    outputSchema: z.object({
      result: z.string(),
    }),
  },
  {
    name: "MY_TOOL_QUERY" as const,
    inputSchema: z.object({}),
    outputSchema: z.object({
      items: z.array(z.string()),
    }),
    opt: true, // Optional tool
  },
] as const satisfies Binder;
```

## Custom Fetch Handler

Handle non-MCP routes alongside your MCP server:

```typescript
export default withRuntime({
  tools: [...],
  
  fetch: async (req, env, ctx) => {
    const url = new URL(req.url);
    
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    
    if (url.pathname.startsWith("/api/")) {
      // Handle API routes
      return handleApiRoutes(req, env);
    }
    
    return new Response("Not Found", { status: 404 });
  },
});
```

## CORS Configuration

Configure CORS for browser-based MCP clients:

```typescript
export default withRuntime({
  cors: {
    origin: ["https://example.com", "http://localhost:3000"],
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-protocol-version"],
  },
  
  // Or disable CORS entirely
  cors: false,
});
```

## Accessing Request Context

Access request context within tools:

```typescript
const myTool = createTool({
  id: "contextDemo",
  inputSchema: z.object({}),
  execute: async ({ runtimeContext }) => {
    const { env, req } = runtimeContext;
    
    // Access MESH_REQUEST_CONTEXT for auth and bindings
    const ctx = env.MESH_REQUEST_CONTEXT;
    
    // Get authenticated user (throws if not authenticated)
    const user = ctx.ensureAuthenticated();
    
    // Access resolved binding state
    const state = ctx.state;
    
    // Get connection info
    const { connectionId, organizationId, meshUrl } = ctx;
    
    // Access original request
    const userAgent = req?.headers.get("user-agent");
    
    return { userId: user.id };
  },
});
```

## Complete Example

Here's a complete example of an MCP server with tools, prompts, resources, and OAuth:

```typescript
import { 
  withRuntime, 
  createTool, 
  createPrivateTool,
  createPrompt,
  createResource,
} from "@decocms/runtime";
import { z } from "zod";

// Public tool - no auth required
const echoTool = createTool({
  id: "echo",
  description: "Echoes the input message",
  inputSchema: z.object({
    message: z.string(),
  }),
  outputSchema: z.object({
    echo: z.string(),
  }),
  execute: async ({ context }) => {
    return { echo: context.message };
  },
});

// Private tool - requires authentication
const getProfileTool = createPrivateTool({
  id: "getProfile",
  description: "Gets the current user's profile",
  inputSchema: z.object({}),
  outputSchema: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
  }),
  execute: async ({ runtimeContext }) => {
    const user = runtimeContext.env.MESH_REQUEST_CONTEXT.ensureAuthenticated();
    return {
      id: user.id,
      email: user.email,
      name: user.user_metadata.full_name,
    };
  },
});

// Prompt template
const analyzePrompt = createPrompt({
  name: "analyze",
  title: "Analyze Data",
  description: "Analyzes provided data and returns insights",
  argsSchema: {
    data: z.string().describe("JSON data to analyze"),
  },
  execute: async ({ args }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Analyze this data and provide insights:\n\n${args.data}`,
        },
      },
    ],
  }),
});

// Resource
const statusResource = createResource({
  uri: "status://server",
  name: "Server Status",
  description: "Current server status and metrics",
  mimeType: "application/json",
  read: async () => ({
    uri: "status://server",
    mimeType: "application/json",
    text: JSON.stringify({
      status: "healthy",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  }),
});

// Export the MCP server
export default withRuntime({
  tools: [echoTool, getProfileTool],
  prompts: [analyzePrompt],
  resources: [statusResource],
  cors: {
    origin: "*",
    credentials: true,
  },
});
```

## API Reference

### Types

- `Tool<TSchemaIn, TSchemaOut>` - Tool definition with typed input/output
- `Prompt<TArgs>` - Prompt definition with typed arguments
- `Resource` - Resource definition
- `OAuthConfig` - OAuth configuration
- `CreateMCPServerOptions` - Full options for withRuntime
- `RequestContext` - Request context with auth and bindings
- `AppContext` - Runtime context passed to execute functions

### Functions

- `withRuntime(options)` - Create an MCP server
- `createTool(opts)` - Create a public tool
- `createPrivateTool(opts)` - Create an authenticated tool
- `createPrompt(opts)` - Create an authenticated prompt
- `createPublicPrompt(opts)` - Create a public prompt
- `createResource(opts)` - Create an authenticated resource
- `createPublicResource(opts)` - Create a public resource
- `BindingOf(name)` - Create a binding reference schema

### Exports

```typescript
// Main entry
import { withRuntime, createTool, ... } from "@decocms/runtime";

// Bindings utilities
import { impl, WellKnownBindings, ... } from "@decocms/runtime/bindings";

// MCP client utilities
import { createMCPFetchStub, MCPClient } from "@decocms/runtime/client";

// Proxy utilities
import { ... } from "@decocms/runtime/proxy";

// Tool utilities
import { ... } from "@decocms/runtime/tools";
```

## Deployment

The server works with any Web Standard runtime:

**Cloudflare Workers:**
```typescript
export default withRuntime({ tools: [...] });
```

**Bun:**
```typescript
const server = withRuntime({ tools: [...] });
Bun.serve({
  port: 3000,
  fetch: server.fetch,
});
```

**Node.js (with adapter):**
```typescript
import { serve } from "@hono/node-server";
const server = withRuntime({ tools: [...] });
serve({ fetch: server.fetch, port: 3000 });
```

## License

See the root LICENSE.md file in the repository.
