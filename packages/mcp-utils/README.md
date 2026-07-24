# @decocms/mcp-utils

Provides composable primitives for MCP bridges, proxies, gateways, transports,
and sandboxed execution.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/mcp-utils` (`packages/mcp-utils`) |
| Kind | TypeScript MCP utility library |
| Runtime | Node.js 24+ |
| Distribution | Public npm package |

## Overview

The Model Context Protocol SDK provides clients, servers, and transports. This
package supplies the glue for joining those pieces: in-process transport pairs,
client-to-server delegation, transport middleware, multi-client aggregation,
shared JSON Schema validation, and QuickJS execution.

The utilities are independent of Studio applications and can be used by other
MCP gateways or proxies.

## Responsibilities

- Connect MCP clients and servers without a network hop.
- Expose an `IClient` implementation as an MCP server.
- Compose transport middleware around any MCP SDK transport.
- Aggregate tools, prompts, resources, and resource templates from many
  clients.
- Execute JavaScript against a narrow MCP client inside QuickJS.
- Reuse a memoized JSON Schema validator across proxy servers.

## Usage

Install the package and its MCP SDK peer (`>=1.27.0`):

```bash
bun add @decocms/mcp-utils @modelcontextprotocol/sdk
```

Bridge a client and server in process:

```ts
import { createBridgeTransportPair } from "@decocms/mcp-utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const { client: clientTransport, server: serverTransport } =
  createBridgeTransportPair();

const server = new Server(
  { name: "example-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
const client = new Client({ name: "example-client", version: "1.0.0" });

await server.connect(serverTransport);
await client.connect(clientTransport);
```

Supported package exports:

| Import path | Surface |
| --- | --- |
| `@decocms/mcp-utils` | Bridge transports, server delegation, transport composition, `IClient`, and shared schema validation |
| `@decocms/mcp-utils/aggregate` | `GatewayClient` and namespace helpers |
| `@decocms/mcp-utils/sandbox` | `runCode` and sandbox result types |

Consumers of the sandbox entry point must also install its QuickJS runtime:

```bash
bun add quickjs-emscripten-core@0.31.0 @jitl/quickjs-wasmfile-release-sync@0.31.0
```

## Architecture

The root entry point contains three layers. `bridge-transport.ts` creates a
client/server transport pair, `server-from-client.ts` turns any `IClient` into
an MCP server, and `compose-transport.ts` builds wrapper pipelines around MCP
SDK transports.

`aggregate/GatewayClient` extends the MCP SDK client. It lazily resolves
upstream clients, fetches all list pages, caches list results, filters selected
capabilities, namespaces tools and prompts, and routes calls back to the owning
client. Resource URIs remain unchanged and use an internal routing map.

`sandbox/runCode.ts` evaluates an ES module in QuickJS. The module must export a
default function that receives a plain MCP client object. Execution applies
time, memory, and stack limits and returns captured console output alongside a
return value or error.

## Development

Run commands from the repository root:

```bash
bun install
bun run --cwd=packages/mcp-utils check
bun run --cwd=packages/mcp-utils test
```

Run a focused test with:

```bash
bun test packages/mcp-utils/src/server-from-client.test.ts
```

Tests cover transport lifecycle, middleware ordering, proxy delegation,
aggregation, schema-validator reuse, and QuickJS execution.

## Boundaries

This package owns reusable MCP mechanics. Studio authentication, tenant policy,
storage, observability wiring, application contracts, and UI behavior do not
belong here.

Keep `@modelcontextprotocol/sdk` as the public peer contract. Do not introduce a
dependency on `@decocms/shared`, an application workspace, or a Studio-only
context; those dependencies would make the low-level bridge layer cyclic or
non-reusable.

Only the three package exports listed above are public. Files below `src/` are
implementation details.

## Protocol behavior

Bridge transports schedule delivery in process and avoid serialization or
sockets. Closing one side propagates lifecycle events to its peer.

`createServerFromClient` delegates tools and, when advertised by capabilities,
resources and prompts. It removes tool `outputSchema` declarations at the proxy
boundary so an intermediary does not reject structured content that the origin
server owns. `toolCallTimeoutMs` overrides the MCP SDK timeout for forwarded
tool calls.

`composeTransport` reduces middleware from left to right: later wrappers become
the outer layers for outgoing messages, and incoming messages traverse the
reverse path.

## Related documentation

- [Studio repository overview](../../README.md)
- [Contribution guide](../../CONTRIBUTING.md)
- [Testing policy](../../TESTING.md)
