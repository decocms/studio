# User Sandbox Plugin

Server plugin for Deco Studio that enables multi-tenant user sandboxing. Lets external apps create embeddable integration flows where their end-users can connect MCPs (like Gmail, Slack, etc.) to get a personal AI agent.

## Overview

**Use case:** You're building a SaaS app and want your users to connect their own integrations (Gmail, Slack, etc.). The User Sandbox plugin:

1. You create a **Template** defining which apps users need to connect
2. When a user wants to connect, you call `USER_SANDBOX_CREATE_SESSION` - this **immediately creates** a Virtual MCP (Agent) for that user and returns a connect URL
3. The agent is unique per `(template_id, external_user_id)` - calling again with the same user returns the **same agent** and a fresh connect URL
4. User visits the connect URL (like a Stripe billing portal link) to authenticate/manage their apps
5. On completion, the user's connections are linked to their agent
6. *(Optional)* Your app receives a webhook/event notification

**Key insight:** The Virtual MCP exists from the first `CREATE_SESSION` call. You get the `agentId` immediately - you don't have to wait for the user to complete the flow. This means you can start building UI around the agent right away.

## Concepts

### Template

A template defines the connect experience for your users:

```typescript
interface Template {
  id: string;
  title: string;                    // "Connect Your Apps"
  description: string | null;       // Shown to user
  icon: string | null;              // Template icon
  required_apps: RequiredApp[];     // Apps user must connect
  redirect_url: string | null;      // Where to redirect after completion
  webhook_url: string | null;       // Webhook to call on completion
  event_type: string;               // Event type for event bus
  agent_title_template: string;     // e.g., "{{externalUserId}}'s Agent"
  agent_instructions: string | null;
  tool_selection_mode: "inclusion" | "exclusion";
  status: "active" | "inactive";
}
```

### Required App

Each app the user needs to connect:

```typescript
interface RequiredApp {
  app_name: string;           // Registry name, e.g., "@anthropic/gmail"
  title: string;              // Display name
  description: string | null;
  icon: string | null;
  connection_type: "HTTP" | "SSE" | "Websocket" | "STDIO";
  connection_url: string | null;
  oauth_config: OAuthConfig | null;  // If app requires OAuth
  selected_tools: string[] | null;   // null = all tools
  selected_resources: string[] | null;
  selected_prompts: string[] | null;
}
```

### Session

A session represents one user's connect flow:

```typescript
interface Session {
  id: string;
  template_id: string;
  external_user_id: string;     // YOUR user ID
  status: "pending" | "in_progress" | "completed";
  app_statuses: Record<string, AppStatus>;
  created_agent_id: string | null;  // Virtual MCP ID
  redirect_url: string | null;
  expires_at: string;
}

interface AppStatus {
  configured: boolean;
  connection_id: string | null;
  error: string | null;
}
```

### Virtual MCP (Agent)

Each user gets one Virtual MCP per template. It aggregates all their connected apps. The agent is created when the session is created (not on completion) to ensure idempotency.

---

## MCP Tools API

These tools require authentication via API key. Call them from your **server-side** code.

### `USER_SANDBOX_CREATE` - Create a Template

```typescript
// Input
{
  title: string;
  description?: string;
  icon?: string;
  registry_id: string;  // Connection ID of your MCP registry
  required_apps: Array<{
    app_name: string;           // e.g., "@anthropic/gmail"
    selected_tools?: string[] | null;
    selected_resources?: string[] | null;
    selected_prompts?: string[] | null;
  }>;
  redirect_url?: string;
  webhook_url?: string;
  event_type?: string;  // Default: "integration.completed"
  agent_title_template?: string;  // Default: "{{externalUserId}}'s Agent"
  agent_instructions?: string;
  tool_selection_mode?: "inclusion" | "exclusion";
}

// Output: Template entity
```

### `USER_SANDBOX_LIST` - List Templates

```typescript
// Input: {}
// Output: { items: Template[] }
```

### `USER_SANDBOX_GET` - Get a Template

```typescript
// Input
{ id: string }
// Output: Template entity
```

### `USER_SANDBOX_UPDATE` - Update a Template

```typescript
// Input
{
  id: string;
  title?: string;
  // ... other fields to update
}
// Output: Updated template
```

### `USER_SANDBOX_DELETE` - Delete a Template

```typescript
// Input
{ id: string }
// Output: { success: boolean }
```

### `USER_SANDBOX_CREATE_SESSION` - Create Connect Session

**This is the main tool you'll use.** Creates (or retrieves) a Virtual MCP for the user and returns a connect URL.

Think of it like Stripe's billing portal: call it whenever you need a URL for the user to manage their connections. Idempotent per `(templateId, externalUserId)`.

```typescript
// Input
{
  templateId: string;           // Your template ID
  externalUserId: string;       // YOUR user's ID (from your system)
  expiresInSeconds?: number;    // Session expiration (default: 7 days)
}

// Output
{
  sessionId: string;
  url: string;          // Send user here: "https://mesh.example.com/connect/{sessionId}"
  expiresAt: string;
  agentId: string;      // Virtual MCP ID - available IMMEDIATELY
  created: boolean;     // true if agent was newly created, false if reusing existing
}
```

**Important:** The `agentId` is returned on the **first call** - you don't need to wait for the user to complete the flow. The agent is unique per (template + user), so subsequent calls return the same agent.

### `USER_SANDBOX_LIST_SESSIONS` - List Sessions

```typescript
// Input
{ templateId?: string }  // Optional filter
// Output
{ sessions: Session[] }
```

### `USER_SANDBOX_LIST_USER_AGENTS` - List User's Agents

Find all agents for a specific external user:

```typescript
// Input
{ externalUserId: string }
// Output
{
  agents: Array<{
    id: string;              // Virtual MCP ID
    title: string;
    external_user_id: string;
    template_id: string | null;
    created_at: string;
  }>
}
```

---

## REST API (Public)

These endpoints are **public** - no Mesh authentication required. The session ID is the credential.

**Base URL:** `/api/user-sandbox`

### `GET /sessions/:sessionId` - Get Session Status

Returns session info, template info, and per-app status.

```typescript
// Response
{
  session: {
    id: string;
    status: "pending" | "in_progress" | "completed";
    external_user_id: string;
    expires_at: string;
    redirect_url: string | null;
    created_agent_id: string | null;
  };
  template: {
    id: string;
    title: string;
    description: string | null;
    icon: string | null;
  };
  apps: Array<{
    app_name: string;
    title: string;
    description: string | null;
    icon: string | null;
    connection_type: string;
    requires_oauth: boolean;
    selected_tools: string[] | null;
    selected_resources: string[] | null;
    selected_prompts: string[] | null;
    status: {
      configured: boolean;
      connection_id: string | null;
      error: string | null;
    };
  }>;
}
```

### `POST /sessions/:sessionId/provision` - Create Connection for App

Provisions a connection for one app. Call this before OAuth.

```typescript
// Request body
{ app_name: string }

// Response
{
  success: boolean;
  connection_id: string;
  already_provisioned: boolean;
  requires_oauth: boolean;
}
```

### `POST /sessions/:sessionId/configure` - Mark App as Configured

Call after successful OAuth or when app doesn't need OAuth.

```typescript
// Request body
{
  app_name: string;
  connection_id?: string;  // Optional, uses provisioned connection if not provided
}

// Response
{
  success: boolean;
  app_name: string;
  status: AppStatus;
}
```

### `POST /sessions/:sessionId/complete` - Complete Session

Call when all apps are configured. Links connections to the Virtual MCP.

```typescript
// Response
{
  success: boolean;
  completed: boolean;
  agentId: string;
  redirectUrl: string | null;  // Includes query params: sessionId, externalUserId, agentId
  eventEmitted: boolean;
  webhookCalled: boolean;
}
```

---

## Connect Flow (Client-Side)

Here's the full flow to implement in your external app:

### 1. User Clicks "Connect Apps" → Your Server Gets/Creates Agent

```typescript
// Your server (Next.js API route)
import { createMCPClient } from "@decocms/mesh-sdk";

export async function POST(req: Request) {
  const { userId } = await req.json();
  
  const client = await createMCPClient({
    meshUrl: process.env.MESH_URL!,
    connectionId: "self",
    orgId: process.env.MESH_ORG_ID!,
    token: process.env.MESH_API_KEY!,
  });

  // This creates the agent on first call, returns existing on subsequent calls
  const result = await client.callTool({
    name: "USER_SANDBOX_CREATE_SESSION",
    arguments: {
      templateId: "your-template-id",
      externalUserId: userId,
    },
  });

  const output = (result as any).structuredContent;
  
  // agentId is available NOW - you can store it, use it immediately
  // You don't need to wait for user to complete the flow
  return Response.json({ 
    connectUrl: output.url,
    agentId: output.agentId,
    isNewAgent: output.created,
  });
}
```

### 2. Redirect User to Connect URL

```typescript
// Your client
const { connectUrl, agentId } = await fetch("/api/create-session", {
  method: "POST",
  body: JSON.stringify({ userId: currentUser.id }),
}).then(r => r.json());

// You already have agentId! Can store it in your database now.
await saveAgentId(currentUser.id, agentId);

// Then redirect user to connect their apps
window.location.href = connectUrl;
```

### 3. User Completes Connect Flow on Mesh

The Mesh UI handles:
- Displaying the apps to connect
- Provisioning connections
- Running OAuth flows (opens popups)
- Marking apps as configured
- Completing the session (links connections to the agent)

### 4. User Redirected Back to Your App

After completion, user is redirected to your `redirect_url` with query params:

```
https://your-app.com/connect/complete?sessionId=xxx&externalUserId=xxx&agentId=xxx
```

### 5. (Optional) Your App Receives Webhook

If `webhook_url` is configured, Mesh POSTs:

```typescript
{
  externalUserId: string;
  agentId: string;
  templateId: string;
  sessionId: string;
  connections: Array<{ id: string; appName: string }>;
}
```

---

## Building Custom Connect UI (External App)

If you want to build your **own** connect UI instead of using Mesh's, here's how:

### Next.js Implementation

```typescript
// app/connect/[sessionId]/page.tsx
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authenticateMcp, isConnectionAuthenticated } from "@decocms/mesh-sdk";

const MESH_URL = process.env.NEXT_PUBLIC_MESH_URL!;

interface AppStatus {
  configured: boolean;
  connection_id: string | null;
  error: string | null;
}

interface RequiredApp {
  app_name: string;
  title: string;
  description: string | null;
  icon: string | null;
  connection_type: string;
  requires_oauth: boolean;
  status: AppStatus;
}

interface SessionData {
  session: {
    id: string;
    status: string;
    redirect_url: string | null;
  };
  template: {
    title: string;
    description: string | null;
  };
  apps: RequiredApp[];
}

export default function ConnectPage({ params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  const queryClient = useQueryClient();

  // Fetch session data from Mesh
  const { data, isLoading, error } = useQuery<SessionData>({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      const res = await fetch(`${MESH_URL}/api/user-sandbox/sessions/${sessionId}`);
      if (!res.ok) throw new Error("Session not found");
      return res.json();
    },
  });

  // Connect an app
  const handleConnect = async (app: RequiredApp) => {
    // Step 1: Provision connection
    const provisionRes = await fetch(
      `${MESH_URL}/api/user-sandbox/sessions/${sessionId}/provision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_name: app.app_name }),
      }
    );
    const { connection_id, requires_oauth } = await provisionRes.json();

    // Step 2: OAuth if needed
    if (requires_oauth || app.requires_oauth) {
      const probeUrl = `${MESH_URL}/mcp/${connection_id}`;
      const authStatus = await isConnectionAuthenticated({ 
        url: probeUrl, 
        token: null,
        meshUrl: MESH_URL,
      });

      if (!authStatus.isAuthenticated && authStatus.supportsOAuth) {
        const authResult = await authenticateMcp({
          meshUrl: MESH_URL,
          connectionId: connection_id,
          callbackUrl: `${window.location.origin}/oauth/callback`,
        });

        if (authResult.error) {
          throw new Error(authResult.error);
        }

        // Save OAuth tokens
        if (authResult.tokenInfo) {
          await fetch(`${MESH_URL}/api/connections/${connection_id}/oauth-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(authResult.tokenInfo),
          });
        }
      }
    }

    // Step 3: Mark configured
    await fetch(`${MESH_URL}/api/user-sandbox/sessions/${sessionId}/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_name: app.app_name, connection_id }),
    });

    // Refresh
    queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
  };

  // Complete session
  const handleComplete = async () => {
    const res = await fetch(
      `${MESH_URL}/api/user-sandbox/sessions/${sessionId}/complete`,
      { method: "POST" }
    );
    const { redirectUrl } = await res.json();
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  };

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {(error as Error).message}</div>;
  if (!data) return null;

  const allConfigured = data.apps.every(app => app.status.configured);
  const isCompleted = data.session.status === "completed";

  return (
    <div className="max-w-lg mx-auto p-8">
      <h1 className="text-2xl font-bold">{data.template.title}</h1>
      <p className="text-gray-600 mt-2">{data.template.description}</p>

      <div className="mt-8 space-y-4">
        {data.apps.map((app) => (
          <div key={app.app_name} className="border rounded-lg p-4 flex items-center justify-between">
            <div>
              <p className="font-medium">{app.title}</p>
              <p className="text-sm text-gray-500">
                {app.status.configured ? "✓ Connected" : "Not connected"}
              </p>
            </div>
            {!app.status.configured && !isCompleted && (
              <button
                onClick={() => handleConnect(app)}
                className="px-4 py-2 bg-blue-600 text-white rounded"
              >
                Connect
              </button>
            )}
          </div>
        ))}
      </div>

      {allConfigured && !isCompleted && (
        <button
          onClick={handleComplete}
          className="mt-6 w-full px-4 py-3 bg-green-600 text-white rounded-lg"
        >
          Complete Setup
        </button>
      )}
    </div>
  );
}
```

### OAuth Callback Page

```typescript
// app/oauth/callback/page.tsx
"use client";

import { useEffect } from "react";

export default function OAuthCallback() {
  useEffect(() => {
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
  }, []);

  return <p>Authentication complete. You can close this window.</p>;
}
```

---

## Completion Events

When a session completes, Mesh can:

### 1. Emit Event (Event Bus)

Event type configured in template (default: `integration.completed`):

```typescript
{
  type: "integration.completed",
  data: {
    externalUserId: string;
    agentId: string;
    templateId: string;
    sessionId: string;
    connections: Array<{ id: string; appName: string }>;
  }
}
```

### 2. Call Webhook

POST to `webhook_url` with same data as event.

### 3. Redirect User

Redirect to `redirect_url` with query params:
- `sessionId`
- `externalUserId`  
- `agentId`

---

## Using the Agent

You get the `agentId` from the **first** `CREATE_SESSION` call - no need to wait for completion. However, the agent won't have any tools until the user connects their apps.

```typescript
// Your server
const userClient = await createMCPClient({
  meshUrl: process.env.MESH_URL!,
  connectionId: agentId,  // The user's Virtual MCP
  orgId: process.env.MESH_ORG_ID!,
  token: process.env.MESH_API_KEY!,
});

// List available tools (empty until user connects apps)
const tools = await userClient.listTools();

// After user completes connect flow, tools are available
const result = await userClient.callTool({
  name: "gmail_send_email",  // Tool from user's connected Gmail
  arguments: {
    to: "someone@example.com",
    subject: "Hello",
    body: "Sent from your connected Gmail!",
  },
});
```

**Tip:** You can check if a user has completed setup by listing tools on their agent. If empty, prompt them to visit the connect URL.

---

## License

MIT
