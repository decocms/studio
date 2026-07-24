# @decocms/tunnel

Carries Fetch requests and streaming responses over NATS Core with a small,
validated `tunnel:` protocol.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/tunnel` (`packages/tunnel`) |
| Kind | Public NATS-backed Fetch transport |
| Runtime | Node.js 24+ with Web Streams |
| Distribution | Public npm package |

## Overview

`@decocms/tunnel` maps the standard Fetch API onto NATS Core subjects. A caller
uses a `tunnel://<hostname>/<path>` URL as if it were making an ordinary request,
while a server registered for that hostname receives a Web `Request` and returns a
Web `Response`.

The transport preserves methods, paths, queries, repeated headers, streamed
request and response bodies, errors, timeouts, and cancellation. Every wire frame
is decoded through a Zod schema before the transport acts on it.

## Responsibilities

- Parse `tunnel:` URLs and map hostnames and request IDs to NATS subjects.
- Encode and validate versioned protocol frames.
- Stream request and response bodies without buffering an entire payload.
- Forward cancellation in both directions.
- Provide startup-race mitigation for NATS Core request publication.
- Distribute requests across servers that share a hostname.
- Bound request deduplication and pending-abort state.
- Emit optional transport diagnostics without owning application logging.

## Usage

Install the package and a compatible NATS Core client:

```bash
bun add @decocms/tunnel @nats-io/nats-core
```

Register a Fetch handler for a tunnel hostname:

```ts
import { serve } from "@decocms/tunnel";

const server = await serve({
  connection: nats,
  hostname: "desktop-alice",
  fetch: async (request) => {
    const url = new URL(request.url);
    return Response.json({ path: url.pathname });
  },
});
```

Call that handler through the tunnel:

```ts
import { createFetch } from "@decocms/tunnel";

const tunnelFetch = createFetch(nats);
const response = await tunnelFetch(
  "tunnel://desktop-alice/health?verbose=true",
);

console.log(await response.json());
await server.close();
```

Pass an options object when timeout, chunking, or diagnostics behavior must be
explicit:

```ts
const tunnelFetch = createFetch({
  connection: nats,
  timeoutMs: 60_000,
  firstFrameTimeoutMs: 10_000,
  idleTimeoutMs: 15_000,
  diagnostics: (event) => logger.debug(event),
});
```

## Architecture

Each request receives a random request ID. The hostname is encoded into a
subject-safe token, and `buildTunnelSubjects()` derives four subject families:
request start, request body, response, and abort.

The caller:

1. Subscribes to the unique response subject.
2. publishes a `request.start` frame to the hostname's request subject.
3. Republishes that start frame until the server acknowledges it or sends another
   response frame.
4. Streams any body as ordered base64url chunks.
5. Reconstructs a Web `Response` from validated response frames.

The server uses a NATS queue group derived from the hostname. When multiple
servers register the same hostname, NATS assigns each request-start message to one
member of that group. The selected server acknowledges the request, reconstructs
the Web `Request`, invokes the supplied handler, and streams the Web `Response`
back to the caller.

The current wire protocol is `tunnel.v1`. Binary chunks use base64url because
frames are JSON. Headers use ordered `[name, value]` tuples so repeated values are
not collapsed at the protocol boundary.

## Development

Run package checks from the repository root:

```bash
bun run --cwd=packages/tunnel check
bun run --cwd=packages/tunnel test
```

Run a focused transport test while iterating:

```bash
bun test packages/tunnel/src/nats.test.ts
```

Format and lint repository changes before committing:

```bash
bun run fmt
bun run lint
```

## Boundaries

- The tunnel validates transport structure; it does not provide authentication,
  authorization, confidentiality, or tenant isolation.
- Restrict NATS permissions to the required subjects and authenticate requests at
  the application handler. A `tunnel:` hostname is a routing key, not a
  capability.
- NATS Core is not durable. If no subscriber receives a publication, the message
  is lost. The request-start republish loop reduces the startup race but does not
  create durable delivery.
- Deduplication suppresses repeated start frames only inside one server process
  and a bounded window. It is not a global exactly-once guarantee.
- The Fetch handler owns application semantics. The tunnel must not interpret
  Studio identities, route authorization, or business payloads.
- Treat protocol changes as wire-contract changes. Breaking frame or subject
  changes require a new protocol version and coordinated rollout.
- Consume response bodies or cancel them. Leaving a stream unread keeps the
  underlying response subscription and request resources alive.

## Reliability and limits

Defaults are deliberately bounded:

| Option | Default | Meaning |
| --- | --- | --- |
| `firstFrameTimeoutMs` | 30 seconds | Maximum wait for the first acknowledgement or response frame |
| `republishIntervalMs` | 1 second | Interval for repeating `request.start` until the first response frame |
| `maxChunkBytes` | 64 KiB | Maximum binary payload represented by one body frame |
| `timeoutMs` | Disabled | Optional deadline for the complete request |
| `idleTimeoutMs` | Disabled | Optional maximum silence between response frames |

The server tracks active or recently seen request IDs for 60 seconds, capped at
10,000 entries. That cache prevents the normal republish loop from executing a
request twice on one server. After expiry, after eviction, or across independent
queue-group members, consumers must still rely on application-level idempotency
for side-effecting operations.

Cancellation publishes an abort frame and aborts the reconstructed Fetch request.
It is cooperative: application handlers and stream producers must observe their
`AbortSignal` for prompt cleanup.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/tunnel` | `createFetch`, `serve`, protocol codecs, subject helpers, stream helpers, and public types |
| `@decocms/tunnel/nats` | NATS Fetch client and server implementation |
| `@decocms/tunnel/protocol` | Zod-backed frame codecs and protocol types |
| `@decocms/tunnel/stream` | Base64url helpers and asynchronous frame queue |
| `@decocms/tunnel/subject` | `tunnel:` URL parsing, subject-token encoding, and subject construction |

These are the supported package entry points. Do not import files below
`@decocms/tunnel/src`.

## Related documentation

- [Sandbox transport and safety boundaries](../sandbox/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
