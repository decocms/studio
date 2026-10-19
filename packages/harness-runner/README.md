# @decocms/harness-runner

Runs coding-agent harnesses inside a sandbox pod, one process per run.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/harness-runner` (`packages/harness-runner`) |
| Kind | Private in-sandbox harness process |
| Runtime | Bun (inside the sandbox image) |
| Distribution | Private workspace package, packed into `packages/sandbox/dist/harness-runner.tgz` and installed into the sandbox image |

## Overview

The Go daemon execs this process for each dispatched run, writes
`{harnessId, input}` to stdin, and reads NDJSON frames (`{chunks, error}`) off stdout as they are
produced. stderr is the pod's log. The daemon adds the run's terminal `done`
frame itself — this process only emits what the harness produced.

The wire is defined by `daemon-go/internal/dispatch/runner.go`; the frame shape
is `harnessRunResultSchema` in `packages/sandbox/dispatch/schemas.ts`.

Two harnesses are implemented: `claude-code`, driven by the Claude Agent SDK,
and `codex`, driven by `codex app-server`. Other identifiers get an
`unknown_harness` error frame and a non-zero exit.

## Responsibilities

- Read the dispatch envelope from stdin and route it to its harness.
- Run the harness against the checkout the daemon already prepared.
- Translate SDK messages into AI SDK `UIMessageChunk`s so nothing downstream of
  the daemon needs new part types.
- Emit a frame per turn, and always emit a final frame — including on a throw.
- Remember the per-thread session id so a follow-up turn resumes.
- Continue an interrupted turn rather than redoing it. `input.resume` means a
  previous attempt was cut short by infrastructure and its conversation is gone;
  the work itself is in the checkout and in git (a replaced pod clones the branch
  the dying daemon pushed on SIGTERM), so the prompt sends the model to
  `git status` / `git log` and checks the remote provider for existing change
  requests first. It forbids opening a second pull
  request.

## Usage

Not imported by Studio. The daemon spawns it through `HARNESS_RUNNER_CMD`:

```bash
echo '{"harnessId":"claude-code","input":{ ... }}' | bun packages/harness-runner/main.ts
```

Model access is configured entirely by environment, pushed down as sandbox env
by Studio and reaching this process as its spawn environment:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic direct |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | OpenRouter's Anthropic-compatible endpoint |
| `CLAUDE_CODE_MODEL` | Optional model pin; unset uses Claude Code's default |
| `CLAUDE_CODE_PATH` | Optional explicit path to the `claude` executable |
| `CODEX_MODEL` | Codex model selected for the run |
| `CODEX_PATH` | Path to the pinned Codex CLI installed in the image |
| `CODEX_HOME` | Local Codex transcript and per-thread session pointer directory |
| `STUDIO_CODEX_AUTH_JSON` | ChatGPT login cache, encrypted at rest by the API and supplied to the runner |
| `CODEX_API_KEY` + `OPENAI_BASE_URL` | Responses API provider credentials, cleared for subscription runs |
| `CLAUDE_CONFIG_DIR` | Claude Code's config dir; also where the per-thread session id is remembered |

The default-off `chat_harness_codex` organization flag selects Codex for new
sandbox chats. Existing chats keep their pinned runtime. Link a ChatGPT login
in Settings → AI Providers using the cache from `codex login`, or configure a
Responses API provider. The API encrypts the cache per user and accepts token
refreshes only while the original credential is still current. The runner
stores auth and MCP configuration in a private temporary directory; only the
`sessions/` transcript tree and the session pointer reach org-fs. A run with
per-tool built-in restrictions fails before starting Codex, since Codex does
not implement Claude's tool subtraction policy.

On Linux, Codex plan and read-only commands require bubblewrap user namespaces
inside the sandbox runtime. Freestyle deployments opt in with
`STUDIO_SANDBOX_FREESTYLE_USER_NAMESPACES=true`; see the
[provider configuration](../sandbox/README.md#hosted-provisioning).

## Architecture

- `main.ts` — the wire: stdin envelope in, NDJSON frames out.
- `claude-code.ts` — SDK options policy, the per-turn loop, session persistence.
- `codex.ts` — app-server requests, isolated runtime configuration, subscription refresh sync, and session resumption.
- `codex-to-ui-chunks.ts` — Codex notifications translated to existing text, reasoning, tool, question, and plan parts.
- `to-ui-chunks.ts` — SDK messages → AI SDK `UIMessageChunk`s, with Claude
  Code's tools renamed to the canonical part names the chat UI renders
  (`Bash` → `bash`, `AskUserQuestion` → `user_ask`, `mcp__studio__<name>` →
  `<name>`, …).

## Development

```bash
bun run --cwd=packages/harness-runner check
bun run --cwd=packages/harness-runner test
```

## Boundaries

- The daemon owns the workspace. This package never clones, installs, or starts
  a dev server — it only runs a harness in a checkout that already exists.
- Always print a result, even on a harness throw: a process that prints nothing
  is a crash to the daemon, and a crash mid-turn must still surface its partial
  chunks plus an `error`.
- Only type-level imports from `@decocms/sandbox` — the dispatch schemas are the
  shared wire contract, and this package must stay runtime-independent of
  Studio's tree so the image installs it standalone.
- Permissions are bypassed by design: the pod is the isolation boundary and
  there is no approval UI upstream. Do not add a prompt path that would block a
  run forever. `AskUserQuestion` and `ExitPlanMode` are answered at once: the
  call is denied, the turn ends, and the user's answer arrives as the next
  turn's prompt. Plan mode (`mode: "plan"`) runs the SDK in its `plan`
  permission mode.

## Related documentation

- [Sandbox package](../sandbox/README.md)
- [Run attachment and dispatch lifecycle](../sandbox/run-attachment.md)
- [Repository guidelines](../../AGENTS.md)
