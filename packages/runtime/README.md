# @decocms/runtime

Provides the framework for building MCP applications behind Studio with typed
tools, bindings, authentication, OAuth, resources, prompts, and triggers.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/runtime` (`packages/runtime`) |
| Kind | Public MCP application framework |
| Runtime | Node.js 24+; Web Fetch API |
| Distribution | Public npm package |

## Overview

`@decocms/runtime` is the application-facing runtime for MCP servers connected to
Studio. It turns declarative tools, prompts, resources, agents, and bindings into a
Fetch-compatible handler. The runtime also supplies the request-scoped Studio
context that application code uses for identity, connection metadata, credentials,
and calls to bound MCPs.

The package exposes source TypeScript through explicit package subpaths. Consumers
should import only the subpath that owns the capability they need.

## Responsibilities

- Create MCP tools with Zod input and output schemas.
- Mount tools, prompts, resources, and event handlers on a Fetch-compatible MCP
  server.
- Resolve Studio request context and bound connections for each request.
- Enforce authenticated access to protected tools, prompts, and resources.
- Serve OAuth metadata and OAuth routes when an OAuth configuration is present.
- Expose scoped access to Studio-managed credentials through the vault client.
- Create trigger-management tools and deliver trigger callbacks to Studio.
- Provide helpers for connection proxies, MCP client stubs, assets, and Decopilot
  applications.

## Usage

Install the package in an MCP application:

```bash
bun add @decocms/runtime
```

Define a tool and export the runtime handler:

```ts
import {
  withRuntime,
} from "@decocms/runtime";
import {
  createTool,
  ensureAuthenticated,
} from "@decocms/runtime/tools";
import { z } from "zod";

const greet = createTool({
  id: "GREET",
  description: "Greet the signed-in user",
  inputSchema: z.object({
    name: z.string(),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  execute: async ({ context, runtimeContext }) => {
    const user = ensureAuthenticated(runtimeContext);

    return {
      message: `Hello, ${context.name}. Signed in as ${user.email}.`,
    };
  },
});

export default withRuntime({
  tools: [greet],
});
```

`withRuntime()` returns an object with a `fetch()` handler. It serves the MCP
endpoint at `/mcp`, delegates any unmatched request to the optional application
`fetch` handler, and applies the configured CORS and OAuth behavior.

Prompts and resources use the same request context:

```ts
import { createPrompt, createResource } from "@decocms/runtime";
import { z } from "zod";

const reviewPrompt = createPrompt({
  name: "review",
  description: "Review a change",
  argsSchema: {
    path: z.string().optional(),
  },
  execute: ({ args }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Review ${args.path ?? "the current change"}.`,
        },
      },
    ],
  }),
});

const statusResource = createResource({
  uri: "studio://status",
  name: "Status",
  mimeType: "application/json",
  read: () => ({
    uri: "studio://status",
    mimeType: "application/json",
    text: JSON.stringify({ ready: true }),
  }),
});
```

`createPrompt()` and `createResource()` protect their handlers by default. Use the
explicit `createPublicPrompt()` or `createPublicResource()` variants only when the
content is safe to expose without a Studio identity.

## Architecture

`withRuntime()` is the composition root. For each incoming request it:

1. Normalizes canonical Studio environment fields and supported legacy aliases.
2. Creates a request-scoped context containing identity and binding state.
3. Initializes configured bindings.
4. Dispatches MCP requests to the server created from tools, prompts, resources,
   agents, and event handlers.
5. Applies OAuth and CORS behavior around the result.
6. Falls back to the application's own `fetch()` handler for non-runtime routes.

The request context is stored with asynchronous request scoping. Tool code receives
that context as the second `execute()` argument; it should not read ambient HTTP
objects or reconstruct Studio identity from process-wide state.

Bindings describe MCP capabilities that a connection implements. `withBindings()`
resolves those bindings for a request, while `BindingOf`, `AgentOf`, and
`proxyConnectionForId()` provide typed access patterns for consumers that need to
call them.

## Development

Run package checks from the repository root:

```bash
bun run --cwd=packages/runtime check
bun run --cwd=packages/runtime test
```

Run a focused test file while iterating:

```bash
bun test packages/runtime/src/tools.test.ts
```

Format and lint repository changes before committing:

```bash
bun run fmt
bun run lint
```

## Boundaries

- This package is an MCP application framework, not the Studio control plane. It
  must not import server implementation details from `apps/api` or UI details from
  `apps/web`.
- Treat the request-scoped runtime context as the authority for identity, Studio
  metadata, and bound services. Do not cache it across requests.
- A tool is not protected merely because it runs behind an MCP endpoint. Call
  `ensureAuthenticated()` in tools that require a user.
- Prompts and resources are authenticated by default. Public variants must expose
  only non-sensitive data.
- Credential access is opt-in and scope-limited. Never request more credential
  material than the application needs, and never persist returned secrets.
- The published package requires Node.js 24 or newer. Individual helpers use Web
  Fetch APIs; environment-specific helpers such as file-backed trigger storage and
  the asset server also require their documented host capabilities.
- Legacy `MESH_*` environment fields and `meshUrl` remain compatibility aliases.
  New code must use `STUDIO_*` names and `studioUrl`.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/runtime` | Runtime composition, prompts, resources, bindings, request context, MCP stubs, and the Studio vault client |
| `@decocms/runtime/proxy` | MCP proxy client primitives |
| `@decocms/runtime/client` | Client for the runtime tool-call HTTP endpoint |
| `@decocms/runtime/bindings` | Binding declarations, registry helpers, and binding initialization |
| `@decocms/runtime/asset-server` | Static and single-page-application asset serving |
| `@decocms/runtime/tools` | Tool creation plus prompt, resource, agent, and authentication primitives |
| `@decocms/runtime/decopilot` | Decopilot application helpers |
| `@decocms/runtime/triggers` | Trigger definitions, configuration tools, and callback delivery |
| `@decocms/runtime/trigger-storage` | In-memory, Studio KV, and JSON-file trigger storage adapters |

These are the only supported package entry points. Do not import files below
`@decocms/runtime/src`.

## Authentication and credential access

`ensureAuthenticated(runtimeContext)` returns the Studio user or throws when the
request is unauthenticated. It is the normal guard for a protected tool.

Applications that need Studio-managed credentials declare an explicit
binding-scoped permission and create a client from the bootstrap passed to
`configuration.onInstall` or `configuration.onChange`:

```ts
import {
  CREDENTIAL_ACCESS_TOKEN_READ_SCOPE,
  createStudioVaultClient,
  type ConfigurationScope,
} from "@decocms/runtime";
import type { StudioVaultBootstrap } from "@decocms/runtime/tools";

const scopes = [
  `github::${CREDENTIAL_ACCESS_TOKEN_READ_SCOPE}`,
] satisfies ConfigurationScope[];

function vaultClient(bootstrap: StudioVaultBootstrap) {
  return createStudioVaultClient({
    baseUrl: bootstrap.baseUrl,
    org: bootstrap.org,
    token: bootstrap.token,
  });
}
```

Use `CREDENTIAL_ACCESS_TOKEN_READ_SCOPE` for a provider access token and
`CREDENTIAL_CONFIGURATION_READ_SCOPE` for non-token credential configuration.
Refresh tokens and OAuth client secrets stay inside the Studio vault and are not
part of the application-facing contract.

## Triggers and persistence

`createTriggers()` creates `TRIGGER_LIST` and `TRIGGER_CONFIGURE` tools from typed
trigger definitions. Its `notify()` method is intentionally fire-and-forget:
delivery failures are logged and are not thrown back into a webhook handler.

Trigger configuration is process-local unless the application supplies a
`TriggerStorage`. Use `StudioKV` when Studio KV is available, `JsonFileStorage`
only for an appropriate local Node/Bun deployment, or provide an adapter backed by
the application's durable store.

## Configuration, bindings, and events

`configuration.state` accepts a Zod schema for persisted MCP configuration.
`BindingOf()` fields in that schema resolve configured connection references into
typed clients on `STUDIO_REQUEST_CONTEXT.state`. Declare required permissions in
`configuration.scopes`; Studio evaluates those scopes when it configures the
connection.

`configuration.onChange` runs for configuration updates and receives the parsed
state, granted scopes, and optional vault bootstrap. `configuration.onInstall`
runs on the first saved configuration and also receives the agent-provisioning
helper. Handlers must be idempotent because network or deployment failures can
interrupt work around these callbacks.

`events.handlers` declares CloudEvent subscriptions by binding key or `SELF`.
The runtime exposes the corresponding `ON_EVENTS` tool and supports both batch
results and per-event results. Event handlers own their idempotency because the
Studio event bus provides at-least-once delivery.

When `oauth` is configured, the runtime serves protected-resource metadata,
authorization-server metadata, authorization, callback, token, and dynamic client
registration routes. The application supplies provider-specific authorization
and token-exchange behavior.

The optional `cors` property controls runtime CORS handling; set it to `false` to
disable the built-in layer. The optional application `fetch()` handler receives
requests that do not match the runtime, OAuth, or tool-call routes.

## Related documentation

- [Bindings guide](./src/bindings/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
