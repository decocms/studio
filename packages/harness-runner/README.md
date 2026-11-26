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
is `harnessRunResultSchema` in `packages/sandbox/dispatch/schemas.ts`. A run
whose input sets `liveMessages` keeps stdin open after the envelope line, and
the daemon writes one `{"liveMessage":{"id","text"}}` line for each message a
person sends while the turn works (`daemon-go/internal/dispatch/live_messages.go`).

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
- Send the turn's message. Claude Code gets the text parts joined into one
  prompt. When the message has `image/*` file parts, it also gets up to 20
  base64 image blocks after the text, on the first turn of a session, a turn
  sent to a kept session, and a resumed one. The bytes come from the file's
  `/app/org/upload/` path in the attachment annotation, not the part's
  presigned URL, and only when that path, with `..` and symlinks resolved, is
  inside the uploads directory. Only JPEG, PNG, GIF and WebP up to 3.75 MB are
  sent, checked by their bytes. Anything else, or a file that cannot be read,
  is skipped, and the model still has the annotation's path line. One message
  carries at most 10 MB of image bytes: images are taken in the order attached,
  and the first one that would cross that total is left to its path line along
  with every image after it. When the provider refuses that turn's first
  request with a client error (a 4xx other than 408 and 429) that the CLI does
  not recover from itself, the turn is resent once as text only. A refused
  request stays in the CLI's transcript and is sent again on every later turn,
  so the resend runs on a copy of the session cut before the turn, or on a fresh
  session when the turn was its first, and the thread's session file moves to
  it. One log line names the provider host and the status. Codex forwards image
  parts by URL.
- Take live messages into the running turn. Claude Code sends each one into
  the SDK's streaming input as a `priority: "next"` user message, which it reads
  between tool rounds; `--replay-user-messages` echoes it back at that point,
  where the run emits a `data-live-message` part naming Studio's message id. A
  message the turn ends without reading starts the CLI's next turn, which the
  same run keeps reading. Codex uses `turn/steer` with the active turn id and
  the Studio message id. Its `userMessage` item echo places the same inline
  marker. The runner confirms delivery only after the native steer succeeds;
  a finishing or refused turn falls back to Studio's queue. Every message gets
  a `{"liveMessageAck":…}` stdout
  line, `accepted: false` once the turn has decided to finish, so the daemon
  answers Studio only with what is true.
- Reach Studio through the `decocms` CLI when the input sets `studioCli`:
  the run's minted key becomes a CLI session (`session.<host>.json`, mode
  0600) in a private directory named by `DECOCMS_HOME`, rewritten every turn
  so a kept session uses the current key. No `studio` MCP server is mounted
  and the MCP preflight is skipped. A single plain
  `decocms tools call <NAME> --org <slug> [-d '<json>']` command renders as
  the `<NAME>` tool part. Codex read-only runs keep the research-only `studio`
  MCP, because their sandbox blocks network for shell commands.
- Point Claude Code's own memory at the folder the input names. `memory` is
  set per run and passed as SDK `settings` (the flag layer, which the CLI reads
  before the checkout's or the user's settings): `autoMemoryEnabled: false`
  when it is off, or `autoMemoryDirectory` with the absolute path the daemon
  resolved on the org mount. Any other path is treated as off, because the CLI
  falls back to its folder on the sandbox's disk for a path it rejects. An
  input without the field keeps the CLI default. A kept session is ended
  instead of reused when the next turn's memory differs.
- Record what a Claude Code run was given. The `finish` chunk of a turn that
  reached a result carries `messageMetadata.context`, which Studio stores on
  the message's `finish` row next to `usage`: the runner, image and CLI
  versions, model, effort, permission mode, tool names, MCP servers with their
  status, agent types, skill counts, whether memory is on, and the length of
  the system prompt append. It never holds prompt text, environment, paths or
  ids. It is taken from the first `init` of the run, so a retry or an image
  resend does not replace it. `init` lists an http MCP server as `pending`
  with none of its tools, so the server status, the MCP tools and which of
  them are deferred are read from the CLI at the turn's first result (two
  local control requests, given up on after one second). The CLI does not say
  which built-in tools are deferred. Skills the organization or the checkout
  owns are counted, never named. The JSON is capped at 4 KB: whole lists are
  dropped, longest first, their counts stay, and `truncated` is set.
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
| `CLAUDE_CODE_EFFORT` | Reasoning effort Studio sets from the run's model; unset or unrecognized runs at `low` |
| `CLAUDE_CODE_PATH` | Optional explicit path to the `claude` executable |
| `CODEX_MODEL` | Codex model selected for the run |
| `CODEX_PATH` | Path to the pinned Codex CLI installed in the image |
| `CODEX_HOME` | Local Codex transcript and per-thread session pointer directory |
| `STUDIO_CODEX_AUTH_JSON` | ChatGPT login cache, encrypted at rest by the API and supplied to the runner |
| `CODEX_API_KEY` + `OPENAI_BASE_URL` | Responses API provider credentials, cleared for subscription runs |
| `CLAUDE_CONFIG_DIR` | Claude Code's config dir; also where the per-thread session id is remembered |
| `STUDIO_SANDBOX_IMAGE_VERSION` | The sandbox image's release version, baked in at build time and recorded in the run context; empty on a local build |

The default-off `chat_harness_codex` organization flag selects Codex for new
sandbox chats of members with a Codex credential; everyone else, including
chats on the deco AI gateway, stays on Claude Code. Existing chats keep their
pinned runtime. Link a ChatGPT login
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

- `main.ts` — the wire: stdin envelope and live messages in, NDJSON frames out.
- `claude-code.ts` — SDK options policy, the per-turn loop, session persistence.
- `codex.ts` — app-server requests, isolated runtime configuration, subscription refresh sync, and session resumption.
- `codex-to-ui-chunks.ts` — Codex notifications translated to existing text, reasoning, tool, question, and plan parts.
- `live-messages.ts` — the live-message line, ack and per-turn bookkeeping.
- `run-context.ts` — the run context: what it is built from, and its size cap.
- `studio-cli.ts` — the CLI session file, its prompt, and recognizing a
  shell command that is one Studio tool call.
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
