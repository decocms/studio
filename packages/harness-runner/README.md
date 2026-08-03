# @decocms/harness-runner

Runs coding-agent harnesses inside a sandbox pod and speaks the Go daemon's
loopback dispatch protocol.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/harness-runner` (`packages/harness-runner`) |
| Kind | Private in-sandbox harness process |
| Runtime | Bun (inside the sandbox image) |
| Distribution | Packed into `packages/sandbox/dist/harness-runner.tgz` and installed into the sandbox image |

## Overview

The sandbox daemon is Go, but the Claude Agent SDK is a TypeScript library that
drives the `claude` CLI. `daemon-go/internal/dispatch/runner.go` therefore
spawns one subprocess per pod and talks to it over loopback HTTP; this package
is that subprocess.

It implements exactly one harness today, `claude-code`. Studio sends a
`HarnessStreamInputWire`; this package runs one Claude Agent SDK turn against
the checkout the daemon already prepared and returns the same
`DispatchSSEEvent` stream every harness returns — so the daemon, the run
projector, `thread_message_parts` and the chat UI are all unchanged.

## Responsibilities

- Serve the daemon's harness-runner wire: ready line, bearer-authenticated
  `POST /run`, NDJSON `DispatchSSEEvent` response always terminated by `done`.
- Translate the Claude Agent SDK message stream into AI SDK `UIMessageChunk`s.
- Derive a stable Claude Code session id per Studio thread so turns resume.
- Exit when the daemon dies, rather than lingering on a bound port.

## Usage

Not imported by Studio — the daemon spawns it. `HARNESS_RUNNER_CMD` in the
sandbox image points at the installed bin:

```bash
HARNESS_RUNNER_MODE=1 HARNESS_RUNNER_TOKEN=<token> decocms-harness-runner
```

It prints its port and then waits:

```text
HARNESS_RUNNER_READY {"port":51234}
```

Model access is configured entirely by environment, pushed down as sandbox env
by Studio:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic direct |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | OpenRouter's Anthropic-compatible endpoint |
| `CLAUDE_CODE_MODEL` | Optional model pin; unset uses Claude Code's default |
| `CLAUDE_CODE_PATH` | Optional explicit path to the `claude` executable |

## Architecture

```text
Studio → daemon POST /_sandbox/dispatch → harness-runner POST /run → Claude Agent SDK → claude CLI
```

- `main.ts` — the wire: server, auth, NDJSON framing, parent-death signal.
- `claude-code.ts` — SDK options policy and the per-turn loop.
- `to-ui-chunks.ts` — SDK messages → `UIMessageChunk`s.
- `session-id.ts` — deterministic per-thread session id (UUIDv5).

Turns are buffered, not streamed: chunks accumulate and flush when the SDK
reports `result`. That makes the assistant message id derivable from the turn's
Anthropic message id, and Studio's own liveness heartbeat covers the silence.

## Development

```bash
bun run --cwd=packages/harness-runner check
bun run --cwd=packages/harness-runner test
```

The image build packs this workspace; see `packages/sandbox/package.json`'s
`build:harness-runner` script and `packages/sandbox/image/Dockerfile`.

## Boundaries

- The daemon owns the workspace. This package never clones, installs, or starts
  a dev server — it only runs a harness in a checkout that already exists.
- The runner wire is defined by `runner.go`. Changing the ready line, the
  bearer, the NDJSON framing or the terminal `done` breaks the daemon.
- A stream that ends without `done` means "crashed" to the daemon. Always
  terminate, even on a harness throw.
- Only type-level imports from `@decocms/sandbox` — the dispatch schemas are the
  shared wire contract, and this package must stay runtime-independent of
  Studio's tree so the image installs it standalone.
- Permissions are bypassed by design: the pod is the isolation boundary and
  there is no approval UI upstream. Do not add a prompt path that would block a
  run forever.

## Related documentation

- [Sandbox package](../sandbox/README.md)
- [Run attachment and dispatch lifecycle](../sandbox/run-attachment.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
