# Native terminal agents implementation plan

## Status

Implemented native cutover. The automated contract suite and driven Tauri
debug-app passes cover Claude Code, Codex, and OpenCode. The original manual
pass validates Claude Code and Codex prompt/title lifecycle, resume,
selected-MCP connectivity, secret handling, and shutdown. The stacked OpenCode
pass validates its three-agent picker, real TUI, provider-owned model and title,
hook-driven status, exact resume, runtime readiness gate, secret handling, and
shutdown.
This document records the intended architecture, the implementation choices,
and the exact validation evidence for replacing Studio Native's structured
chat and native Decopilot execution path with real interactive Claude Code,
Codex, and OpenCode TUIs running in PTYs. The exhaustive Tauri matrix remains below as a
release-candidate regression checklist; scenarios not named in the validation
record were not manually re-exercised in this change.

This is an atomic native cutover:

- The hosted web build keeps its current chat UI, AI SDK transport, and backend
  contracts unchanged.
- The native build renders either the Claude Code/Codex/OpenCode selection empty
  state or an interactive xterm terminal. It never renders the message list,
  composer, queue tray, structured tool UI, or cloud-provider picker.
- The native Rust Decopilot message/stream/queue implementation is removed.
  Stale calls fail closed locally and can never fall through to hosted
  Decopilot.
- Existing local thread metadata and historical message data are preserved, but
  no old queued prompt is executed after the migration.

## Product decisions

1. A new, unlocked native thread shows the Claude Code/Codex/OpenCode empty
   state. Selecting an agent starts that CLI immediately in an idle interactive
   TUI.
2. The selected harness is pinned transactionally to the thread. A locked
   thread automatically attaches to a live session or resumes its persisted
   provider conversation when opened.
3. Terminal input is the primary interaction model. Studio does not attempt to
   reconstruct AI SDK messages from ANSI output.
4. Studio keeps its local thread catalog, sidebar statuses, branch/sandbox
   pins, title generation or provider-title ingestion, Virtual MCP, and
   organization filesystem behavior.
5. PTY lifetime and turn lifetime are separate. A completed turn leaves the
   coding-agent process alive at its prompt.
6. Closing or hiding the panel detaches the webview only. Explicit stop, thread
   deletion/archive, logout/account change, or app shutdown reaps the full
   process tree.
7. Every provider receives the selected Studio Virtual MCP under the reserved
   `cms` name with a launch-scoped bearer. Claude Code and Codex use isolated
   MCP configuration; OpenCode receives a final inline overlay while retaining
   its user/provider configuration, so user-managed OpenCode MCPs may coexist.

### OpenCode stacked extension

- OpenCode is a native terminal identity only. It is not added to the shared
  hosted/headless `HarnessId` or the AI SDK dispatch schemas.
- Studio qualifies OpenCode 1.18.10 or newer. Availability requires its
  version plus a bounded, credential-free, plugin-free database query because
  a working `--version` alone does not prove the TUI runtime can initialize.
  Provider readiness remains visible and actionable in its real TUI.
- A launch-scoped `OPENCODE_CONFIG_CONTENT` adds a launch-unique
  `studio-native-*` primary agent, Studio instructions, the selected `cms` MCP,
  and a local lifecycle plugin without mutating global or project
  configuration. The unique identity keeps the managed agent authoritative
  under OpenCode's deep config merge.
- Fresh sessions use the ordinary TUI; exact resume is
  `opencode --session <provider-session-id>`. Studio never uses ambiguous
  `--continue`.
- Root-session plugin events drive busy/retry/idle/error and
  permission/question states. Child-session events are filtered both in the
  plugin and at the hook normalization boundary.
- OpenCode's `session.updated.info.title` is authoritative. Studio accepts a
  validated generated title only while the chat is still `New chat`, so a
  manual rename always wins and no second title model process is spawned.
- OpenCode owns arbitrary provider/model selection; `/models` advertises it
  with an empty tier list instead of inventing fixed Studio model IDs.

## Non-goals

- Changing hosted web chat behavior or removing its AI SDK implementation.
- Parsing terminal output to infer prompts, tool calls, status, titles, or
  provider session IDs.
- Synchronizing native terminal transcripts to hosted Studio.
- Recreating structured tool cards, approvals, or the old native FIFO queue.
- Supporting arbitrary shells, SSH sessions, Windows, or Orca's multi-pane and
  daemon architecture in the first version.

## Target architecture

```text
Hosted web entry
  -> hosted task runtime
  -> Chat.ActiveTaskProvider + ChatSidePanel
  -> existing AI SDK/SSE path

Native entry
  -> native runtime adapter
  -> NativeAgentTerminalProvider + NativeAgentTerminalPanel
  -> xterm.js
  -> authenticated same-origin WebSocket
  -> local-api AgentSessionRegistry
  -> terminal-session PTY actor
  -> interactive Claude Code, Codex, or OpenCode

Provider hooks
  -> token-authenticated loopback receiver
  -> normalized lifecycle state machine
  -> fenced SQLite update
  -> existing /api/:org/watch event
  -> sidebar status/title
```

The terminal is the native data plane. Studio's thread catalog, launch context,
Virtual MCP, lifecycle state, and title are the control plane.

## Invariants

- One live PTY exists per
  `(account_scope, organization_id, thread_id, thread_generation)`.
- Concurrent starts coalesce. If two different harness selections race, the
  first committed pin wins and the other receives a conflict.
- No process is started until the current thread generation and account/org
  scope are proven.
- A start racing delete cannot escape after the delete fence.
- WebSocket disconnect never changes thread status and never kills the PTY.
- Status is derived from structured hooks, not ANSI, OSC titles, punctuation,
  or process existence.
- Terminal session ID, provider session ID, and Studio thread ID remain
  separate identities.
- MCP capabilities, hook tokens, authorization headers, and full system prompts are
  never persisted in session rows, placed in argv, sent to the webview, or
  written to terminal replay.
- On restart, Studio may resume a provider session but never replays an accepted
  user prompt or a legacy queued prompt.
- Once a prompt frame has crossed a WebSocket, a disconnect is treated as an
  ambiguous delivery and the renderer never resends it automatically. It
  reconnects only for output replay and asks the user to inspect the terminal.
- SQLite commits precede watch events. A client responding to an event always
  rereads committed state.
- Slow or disconnected subscribers cannot backpressure the PTY reader.
- The newest WebSocket attachment owns terminal mutations. Claiming a new
  writer waits for any current frame to finish, and stale attachments receive
  a non-retryable error rather than interleaving input.
- Terminal admission and every authenticated-subject transition share one
  process-wide gate. A hard sign-out reaps all PTYs, and a different subject is
  not installed until every old-subject PTY is gone.

## Native HTTP and WebSocket contract

Register these as literal guarded Axum routes before the app-API proxy fallback.
They cannot use `intercept::try_intercept`, because that path buffers the request
body and loses `WebSocketUpgrade`.

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/:org/threads/:threadId/terminal` | Idempotently select/pin a harness and create or resume a PTY session. |
| `GET` | `/api/:org/threads/:threadId/terminal` | Return persisted/live session metadata without terminal bytes. |
| `GET` | `/api/:org/threads/:threadId/terminal/ws` | Upgrade to the terminal WebSocket and attach to the existing session. |
| `DELETE` | `/api/:org/threads/:threadId/terminal` | Explicitly terminate the current PTY session. |
| `POST` | `/_local/agent-hooks/:sessionId` | Receive provider hooks using a random per-session bearer token. |

The webview terminal routes use the existing embedded Host, Origin, and
HttpOnly control-cookie guard. Each provider child instead receives two
independent random capabilities: one for its hook receiver and one accepted
only at the exact encoded path of the selected MCP. Neither capability unlocks
another local API route, and the MCP bearer is stripped before upstream
forwarding.

### Start request

The browser may supply only user choices and display dimensions:

```json
{
  "harnessId": "claude-code",
  "approvalMode": "default",
  "planMode": false,
  "cols": 100,
  "rows": 30
}
```

The equivalent WebSocket `start` handshake may additionally carry one
`initialPrompt` and its opaque `requestId`. That pair is size-bounded and
deduplicated by the process-local prompt ledger. Neither field exists on the
REST start body.

The backend resolves thread scope, cwd, system instructions, Virtual MCP, auth,
resume identity, and executable. It must not accept arbitrary system prompts,
MCP URLs, cwd values, cookies, or provider session IDs from JavaScript.

The response contains nonsecret authoritative state: terminal session ID,
harness pin, physical/logical state, provider-session availability, and the
current opaque persisted thread-generation string.

### WebSocket protocol

- The first client text frame is `start` or `attach` and includes bounded rows
  and columns.
- Client JSON controls are `start`, `attach`, `input`, `resize`, `interrupt`,
  `terminate`, and `submit_prompt`. Binary client frames are also accepted as
  raw PTY input for non-webview clients.
- Server text events are `ready`, `output`, `reset`, `state`,
  `prompt_accepted`, `exit`, and `error`.
- `output.dataBase64` preserves arbitrary PTY bytes. `seq` is the exclusive
  absolute byte offset after the chunk, so reconnects attach with `afterSeq`
  and deterministically discard duplicates.
- A request older than the retained byte ring receives `reset` at the first
  available offset followed by retained output chunks.
- JSON frame size, dimensions, input writes, replay bytes, control queues, and
  broadcast capacity are bounded and validated.
- Every attachment can observe output. A monotonic lease makes only the newest
  attachment authoritative for input and controls; stale writers receive a
  non-retryable `stale_attachment` error.

`submit_prompt` exists for autosend and non-chat surfaces such as the visual
editor. It is not the old queue. The backend accepts it only at a safe provider
prompt boundary (or as the one-shot initial prompt); otherwise it returns
`agent_busy`. Direct human terminal input remains raw and immediate.

## Rust ownership

### New `terminal-session` crate

Add:

```text
apps/native/crates/terminal-session/
  Cargo.toml
  src/lib.rs
  src/manager.rs
  src/replay.rs
  src/session.rs
  src/types.rs
  tests/session_manager.rs
```

This crate owns interactive process mechanics only. It must not know about
Studio organizations, SQLite threads, upstream auth, or Virtual MCP entities.

The session actor is the sole owner of the PTY master, child, signaling, and
exit transition. Dedicated blocking reader and writer threads communicate with
it through bounded queues. The public session handle supports:

- `Write`
- `Resize`
- `Interrupt`
- `Terminate`

Prompt admission, attachment ownership, and Studio lifecycle persistence live
in local-api rather than this provider-neutral crate.

`portable-pty` exposes blocking handles. Reads and waits therefore run on
dedicated threads or bounded `spawn_blocking` work; no blocking operation may
run on local-api's Tokio request workers.

PTY allocation failure is fatal for the session. There is no plain-pipe
fallback for an interactive TUI.

The actor reuses Studio's process-lifetime fence and process-tree cleanup
semantics: graceful TERM, bounded wait, KILL escalation, child reaping, and app
crash watchdog. Shutdown must prove no descendant survives.

### Replay

Keep a bounded 4 MiB byte ring in the process-owned terminal session. Every
published chunk has absolute start/end byte offsets. An attachment behind the
retained range receives an explicit reset marker and the complete retained
suffix; xterm resets before applying it. Replay intentionally does not survive
an app restart: provider resume restores the conversation, while stale terminal
screen bytes and accepted user input are never replayed into a new process.

### Local API integration

Add:

```text
apps/native/crates/local-api/src/terminal/
  mod.rs
  registry.rs
  launch_context.rs
  lifecycle.rs

apps/native/crates/local-api/src/routes/terminal.rs
apps/native/crates/local-api/src/routes/agent_hooks.rs
```

`AgentSessionRegistry` lives in `AppState`; do not introduce another process
global `OnceLock`. It keys sessions by the full thread fence, coalesces starts,
owns hook routing, and coordinates delete/archive/logout/shutdown.

The server-owned launch-context builder extracts the useful provider-neutral
work formerly embedded in native Decopilot execution:

- authenticated account and organization scope;
- immutable thread generation and harness pin;
- selected Virtual MCP and agent instructions;
- sandbox ensure and canonical cwd;
- organization filesystem prompt;
- model, approval, and plan choices;
- local org-scoped MCP endpoint, exact-path bearer capability, and CA;
- persisted provider resume identity.

It returns a `PreparedLaunch`; debug output includes environment keys but never
their values.

## Provider launch behavior

### Shared policy

- Resolve the CLI using the existing authenticated detection/resolution path.
- Spawn the resolved executable directly with structured argv. Do not build a
  shell command string. Add a login-shell compatibility path only if a real
  Finder/Dock launch proves current PATH repair insufficient.
- Rebuild MCP credentials on every spawn/resume.
- Preserve user authentication and ordinary CLI behavior, but isolate Studio's
  managed hook and MCP additions.
- A fresh session starts without a user prompt after empty-state selection.
  Autosend may be supplied as the one explicit initial prompt.

### Claude Code

Interactive argv removes headless `-p`, stream JSON, partial-message, and
verbose flags. It retains:

- `--append-system-prompt-file` with the Studio launch context;
- `--mcp-config` using environment references;
- `--strict-mcp-config` for the selected Studio Virtual MCP;
- interactive-safe model, permission, and plan settings;
- `--resume <providerSessionId>` for resumed conversations.

Generate a per-session settings overlay containing Studio hooks. Verify in the
compatibility spike that `--settings` merges safely with user configuration and
that all required hook events fire in interactive mode. Do not rewrite the
user's global Claude settings file.

### Codex

Interactive argv removes `exec` and `--json`. It retains:

- provider/developer instructions;
- Studio MCP configuration with environment-backed headers;
- model, sandbox, approval, and plan settings;
- interactive `resume <providerSessionId>` ordering.

Codex uses one app-private, account-scoped `CODEX_HOME`. Its regular
`auth.json`, provider session history, and generic Studio hook files are owned
by the account rather than any one thread, so Codex's atomic credential refresh
is visible to future chats. Thread-specific developer instructions and MCP
configuration live in distinct Codex profiles; deleting a thread removes its
profile but deliberately retains the account's provider history and auth. Seed
the managed credential only during atomic first initialization, refuse
symlink/non-regular auth files, and never silently reseed a credential deleted
after initialization. Never bypass trust globally or blindly mutate
`~/.codex`.

### OpenCode

Interactive argv selects the launch-unique `studio-native-*` primary agent and
uses `--session <providerSessionId>` for exact resume. It does not use
`--continue` or `--pure`. Studio passes `--auto` only when the user explicitly
chooses auto mode outside read-only/plan mode. Read-only and plan launches deny
OpenCode's `edit`, `bash`, and `task` permissions so writes cannot be performed
directly, through a shell, or through a delegated subagent. Provider/model
selection remains owned by the user's OpenCode configuration.

`OPENCODE_CONFIG_CONTENT` supplies the Studio agent prompt, an environment-
referenced remote `cms` MCP, and a file-URL lifecycle plugin from the private
per-thread state directory. The overlay is process-local and leaves global and
project files untouched. OpenCode emits its own root-session title; Studio does
not launch a competing title subprocess.

## System instructions and Virtual MCP

Server-side prompt composition is explicit and versioned:

1. Studio's native coding-agent guardrails.
2. The selected Virtual MCP's instructions, knowledge, and skill context.
3. The organization filesystem prompt and thread memory location.
4. Optional one-shot context from an authorized Studio surface.

The CLI still discovers repository and user instruction files through its
ordinary behavior. Avoid duplicating those files into the appended prompt.

All providers receive the same selected, org-scoped local `cms` MCP endpoint.
Their managed configuration references `DECOCMS_MCP_AUTHORIZATION`; the random
value exists only in the child environment. The browser control cookie and
Origin are never given to the CLI. No secret is interpolated into argv or
configuration text visible to the terminal.

## Hook control plane

Each session receives:

- a stable terminal session ID;
- the Studio thread fence;
- a random hook bearer token;
- the loopback hook URL;
- provider-specific managed hook configuration.

Claude and Codex hook scripts read provider JSON from stdin and POST it
quickly. OpenCode's launch-scoped plugin POSTs its structured events directly.
Both paths fail open: a broken Studio status integration must not block the
coding agent.

Normalize provider/version-specific payloads into:

```text
SessionStarted
PromptSubmitted
ToolStarted
ToolFinished
WaitingForApproval
WaitingForInput
TurnCompleted
ProviderSessionDiscovered
```

Map them to existing thread state as follows:

| Normalized event | Thread status |
| --- | --- |
| `SessionStarted` | Retain `completed`; opening a TUI is not work. |
| `PromptSubmitted`, `ToolStarted`, `ToolFinished` | `in_progress` |
| `WaitingForApproval`, `WaitingForInput` | `requires_action` |
| Enter submitted while waiting | Optimistically `in_progress`, corrected by the next hook. |
| `TurnCompleted` | `completed` |
| Unexpected PTY exit while active | `failed` |
| Clean exit while idle | Retain `completed` |

The physical session separately tracks `starting`, `running`, and `exited`.
`interrupted` and `failed` are terminal logical states, which keeps process
existence separate from the outcome of the last turn or ownership transition.

## Titles and provider resume

For Claude Code and Codex, on the first `PromptSubmitted` event:

1. CAS `New chat` to the existing deterministic fallback title.
2. Start the existing low-cost, no-tools title subprocess asynchronously.
3. CAS the generated title only if the deterministic title remains unchanged.
4. Publish the committed thread row through `/api/:org/watch`.

Manual rename always wins. Starting an idle TUI does not title the thread.

The title helper receives the prompt over stdin, never argv. Claude runs in
safe mode with no MCP; Codex uses the same managed account home as the terminal
but ignores profiles/rules and disables hooks, apps, and plugins. Failure is
silent after the deterministic fallback has been stored.

OpenCode does not use that title subprocess. Its root session emits the
provider-generated title in `session.updated`; Studio validates it and CASes
`New chat` directly to that title. Child-session titles are ignored and a
manual rename always wins.

Checkpoint the provider session ID as soon as a structured hook reports it.
On app restart, mark old physical sessions interrupted. Reopening a locked
thread creates a new PTY using the provider resume ID; it never replays old
input. No persisted PID is trusted after restart.

## Persistence and migration

Retain the historical migration ladder verbatim and add a new migration.
Never rewrite old migration SQL.

Add `native_terminal_sessions`, keyed and foreign-keyed by the full thread
fence, with fields equivalent to:

```text
id
account_scope
organization_id
thread_id
thread_generation
harness_id
provider_session_id
physical_state
logical_state
revision
blocks_prior_provider_resume
started_at
ended_at
exit_code
last_error
created_at
updated_at
```

A partial unique index permits one live physical session per thread generation.
Do not persist hook tokens, MCP credentials, system prompts, authoritative PIDs,
or raw user input in this table.

Upgrade behavior:

1. Preserve `native_scoped_threads`, titles, metadata, harness/branch/sandbox
   pins, and historical messages.
2. Archive the old turn queue rather than executing or immediately dropping it.
3. Never start a migrated queued or running prompt.
4. Recover the newest valid provider session ID from existing checkpoints when
   possible.
5. Mark an interrupted legacy active thread `requires_action` and record
   nonsecret migration metadata.
6. Remove obsolete run-spool files only after the schema migration and app-root
   instance lock are held.
7. Make every migration/recovery action idempotent across crashes.

Historical message/queue tables may remain physically present for one release
to avoid destructive user-data loss, but terminal code never reads or writes
them for execution. Dropping them is a later, explicit retention decision.

## Minimal hosted-web changes

### Runtime adapter

Add a transport-free runtime slot, for example:

```text
apps/web/src/lib/desktop/agent-runtime-slot.tsx
```

It exposes an `ActiveTaskProvider` and `SidePanel` component. It imports no
xterm, WebSocket, Tauri, or native controller code.

Only `index.native.tsx` imports and installs the concrete implementation:

```text
apps/web/src/desktop/agent-terminal/runtime-provider.tsx
apps/web/src/desktop/agent-terminal/active-task-provider.tsx
apps/web/src/desktop/agent-terminal/terminal-panel.tsx
apps/web/src/desktop/agent-terminal/terminal-controller.ts
apps/web/src/desktop/agent-terminal/protocol.ts
```

The agent shell substitutes the adapter at its two existing active-task
provider sites and at `ActiveTaskBoundary`. Hosted web receives no adapter and
continues to mount `Chat.ActiveTaskProvider` plus `ChatSidePanel`.

The native provider surrounds the whole task workspace, not only the visible
terminal. Hiding the side panel or switching main tabs therefore detaches the
xterm view without destroying the controller.

### Existing agent-selection empty state

Give `NativeAgentEmptyState` an `onSelect` callback while retaining its existing
detection display and preference update.

Fresh unlocked thread behavior:

1. Render the current Claude Code/Codex/OpenCode options; do not auto-spawn the first
   detected CLI.
2. Selection calls the start endpoint with the corresponding harness.
3. The backend authoritatively detects, pins, and starts it.
4. On success, replace the empty state with xterm and patch the live thread row
   from the server response.
5. On missing CLI or launch failure, retain the picker and show a translated
   actionable error. Never fall back to hosted chat.

After launch, the panel contains only xterm. Studio does not add a terminal
toolbar, lifecycle label, error banner, or action buttons; lifecycle remains in
the sidebar and terminal-native controls such as Ctrl-C remain available through
xterm input.

Locked threads skip the picker and ensure/attach their persisted harness.

### Compatibility command bridge

Some non-chat panels currently require `useChatStream()` only to send a prompt,
stop work, or read run status. Removing the active provider without a
replacement would make those panels throw.

Export a thin value-provider for that existing context and populate it from the
terminal controller:

- `sendMessage` -> derive plain prompt text and call `submit_prompt`;
- `stop` -> terminal interrupt;
- status flags -> normalized hook lifecycle;
- messages -> empty;
- pagination/queue operations -> unsupported/no-op;
- structured tool-result submission -> explicit unsupported error.

This is an interface compatibility shim, not an AI SDK transport: it never
opens `ThreadConnection`, reads messages, or calls Decopilot.

Autosend is claimed exactly once by the native provider and becomes the initial
prompt when possible. A definitive rejection gets one bounded retry window; an
accepted prompt clears the handoff. A disconnect after send clears the handoff
as delivery-ambiguous instead of risking a duplicate. React Strict Mode
remounts must not duplicate it.

### xterm

The terminal component owns xterm and FitAddon lifecycle only:

- enable stdin and forward `onData` through bounded UTF-8-safe JSON chunks;
- send fitted dimensions and later resize changes;
- apply replay before live output;
- reconnect with the last rendered byte offset;
- preserve focus, selection, copy, paste, Unicode, and bracketed-paste behavior;
- dispose browser resources on unmount without stopping the backend process.

Add English and pt-BR strings for connecting, starting, reconnecting, retry,
missing CLI, exit, and terminal errors.

## Native legacy removal

Delete after the terminal cutover is active:

- `local-api/src/routes/intercept/decopilot.rs`
- `local-api/src/routes/intercept/run_spool.rs`
- native queue claim/finalize/cancel/recovery code and tests
- AI SDK chunk/status/title streaming from native execution
- native Decopilot resume tests and queue-recovery tests, replacing them with
  interactive equivalents

Retain:

- `native_scoped_threads` and thread CRUD/tool interception
- `/api/:org/watch` and the `decopilot.thread.status` event name used by shared
  sidebar code
- historical message rows initially
- CLI detection, resolution, terminal launch builders, and title runners
- sandbox, org filesystem, preview, git, task, and setup machinery

Continue intercepting every old `/api/:org/decopilot/*` request, but return:

```json
{
  "error": "native_chat_removed"
}
```

with `410 Gone`. This prevents a stale native bundle from silently reaching
hosted Decopilot.

## Implementation phases

### Phase 0: provider compatibility spikes

Prove with the installed real CLIs before designing around assumptions:

- interactive Claude Code, Codex, and OpenCode argv/resume ordering;
- PTY detection, alternate-screen behavior, resize, Ctrl-C, and clean exit;
- provider hook event names and payloads, including first provider session ID;
- Claude per-session settings merge behavior;
- Codex hook configuration/trust and private `CODEX_HOME` behavior;
- selected Virtual MCP connection over local TLS with environment-backed auth;
- Studio system instruction behavior on fresh and resumed sessions.

Record supported CLI versions and fail clearly below them. This phase is a hard
gate, especially for Codex hooks and OpenCode plugin events.

### Phase 1: interactive PTY foundation

- Add the `terminal-session` crate and PTY actor.
- Add the validated JSON/base64 protocol with absolute byte offsets.
- Add bounded replay, input ownership, backpressure, resize, interrupt, and
  process-tree cleanup.
- Build a deterministic PTY fixture that asserts stdin/stdout are TTYs, emits
  ANSI and split Unicode, reports resize, forks descendants, hangs, and crashes.

Gate: black-box tests prove input/output/resize/reconnect/kill behavior without
a real provider.

### Phase 2: local API, persistence, and lifecycle

- Add schema migration and fenced session CRUD.
- Add `AgentSessionRegistry` to `AppState` and ordered shutdown.
- Register terminal and hook routes before proxy fallback.
- Integrate create/start/delete/archive/logout/account-switch generation fences.
- Normalize stale sessions on boot and implement provider-resume metadata.
- Emit thread status through the existing watch path after commit.

Gate: tenant isolation, concurrent start, delete race, restart, and shutdown
tests pass using the PTY fixture.

### Phase 3: provider launch context and hooks

- Extract server-owned launch context from native Decopilot.
- Add interactive Claude Code/Codex/OpenCode builders.
- Add hook overlays/receiver/normalizers.
- Inject system instructions and the selected Virtual MCP.
- Add title and provider-session checkpoints.

Gate: stub hook fixtures plus opt-in real-CLI smoke tests prove lifecycle,
title, MCP, secrets, and resume.

### Phase 4: native renderer cutover

- Add the runtime adapter and native-only terminal modules.
- Replace both native active-task provider sites and the side panel.
- Wire the current agent empty state to explicit start.
- Add the compatibility command bridge and exactly-once autosend.
- Implement xterm attach/input/resize/replay/reconnect and translated errors.

Gate: native makes no Decopilot message/stream/queue requests; hosted web tests
and behavior remain unchanged.

### Phase 5: remove native Decopilot execution

- Migrate/archive legacy active queue state without executing it.
- Delete native Decopilot execution and run spool code.
- Remove queue recovery from startup, thread CRUD, watch, and shutdown.
- Install the local `410 Gone` backstop.
- Replace native Decopilot/resume/queue tests with terminal equivalents.
- Add a native bundle/network guard for old route literals and runtime calls.

Gate: stale routes fail locally and upstream receives zero old native chat
requests.

### Phase 6: hardening and final UI validation

- Exercise long output, replay limits, slow subscribers, reconnection gaps,
  repeated resize, Unicode, paste, and focus.
- Test app/webview reload, app quit, external CLI death, delete, archive, logout,
  and account switch.
- Run all providers against a real Studio Virtual MCP and real sandbox.
- Validate every required UI state through the Tauri DevTools MCP bridge.
- Run dead-code analysis and remove newly orphaned native exports/helpers.

## Test plan

### Pure/unit tests

- Interactive argv/env building, including absence of secrets in argv.
- Hook payload validation and provider-neutral lifecycle normalization.
- Logical/physical state transitions and unexpected-exit priority.
- Protocol encoding, frame limits, sequence arithmetic, and resize clamping.
- Replay boundaries, gaps, caps, invalidation, and garbage collection.
- Title CAS and manual-rename race.
- Session-row transition fencing and provider-session checkpoint validation.
- Exactly-once autosend state decisions and prompt conversion.

### Native black-box E2E

- Authentication, Host/Origin, exact-path MCP capability, account/org/thread-
  generation isolation.
- Concurrent idempotent start and conflicting harness selection.
- Real TTY, byte-exact ANSI/Unicode input/output, split UTF-8, and bracketed
  paste.
- Resize reaches the child and produces the expected rows/columns.
- Disconnect/reattach keeps the same process and has no replay gap or duplicate.
- Slow clients cannot stall the child and replay remains bounded.
- Hook state commits before watch emission.
- First prompt titles once; manual rename wins.
- Correct cwd for branch sandbox and gitless org filesystem.
- Selected MCP and system instructions reach only the selected provider.
- Control cookies, tokens, and prompts appear in neither argv, replay, errors,
  nor JS frames; Claude/Codex title prompts are delivered through stdin, while
  OpenCode uses its provider-owned session title without a title subprocess.
- Ctrl-C, provider exit, crash, explicit stop, thread delete, archive, logout,
  app shutdown, and descendant reaping.
- Restart resumes from provider ID without resending input.
- Legacy migration preserves thread/message data and executes no queued prompt.
- Every old native Decopilot path returns local `410` and never reaches upstream.

Keep thread-tool interception, terminal-session persistence, CLI detection,
sandbox, git, preview, setup, and hosted web suites unless their shared
interface truly changes.

### Build and boundary checks

- `bun run --cwd=apps/web build:web` retains hosted chat behavior.
- `bun run --cwd=apps/web build:native` contains the terminal implementation.
- Native runtime tests assert no `ThreadConnection` is created and no
  Decopilot message/stream/queue/cancel request occurs.
- A static bundle check requires unique terminal protocol markers only in the
  native build. Shared non-chat surfaces may keep inert legacy route strings in
  that bundle; black-box request assertions, rather than string absence, prove
  the native runtime never activates them.
- Existing hosted Playwright chat tests pass without changed expectations.

## Validation record (2026-07-31)

The manual evidence in this record predates the OpenCode extension and
deliberately preserves the Claude Code/Codex results from that pass. The
OpenCode extension has its own driven record below.

The final debug-app pass used the Tauri DevTools MCP bridge against an isolated
`com.decocms.studio.terminaltest` app-data namespace. It did not reuse or stop
the installed production app.

- A fresh chat rendered the Claude Code/Codex picker with no message list,
  composer, queue tray, or cloud-provider picker.
- Selecting each provider spawned its real interactive TUI in one xterm. Claude
  returned `CLAUDE_NATIVE_OK gimenes-guarana-works`; Codex returned
  `CODEX_NATIVE_OK guarana-works`. Both sidebar rows settled at `Done`.
- After the TLS, CLI-version, generation-fence, autosend, and legacy-queue
  hardening landed, a rebuilt debug app repeated the fresh-chat picker flow.
  Claude Code 2.1.220 returned `HARDENED_CLAUDE_OK`, Codex CLI 0.146.0 returned
  `HARDENED_CODEX_OK`, and switching back to the Claude chat replayed its exact
  result in xterm. Both final rows again settled at `Done`, and each provider
  returned to its own input prompt inside xterm.
- Codex's first explicit prompt generated the title
  `Reply with workspace basename`. Switching between chats replayed each
  provider's output exactly once and kept one attached xterm.
- A process-level restart marked both formerly running terminal rows
  interrupted. Reopening the locked chats created new PTYs with their stored
  provider session IDs; the resumed providers returned `CODEX_RESUME_OK` and
  `CLAUDE_RESUME_OK` without Studio resending the earlier prompts.
- Each real provider's `/mcp` screen reached the selected `cms` server. Codex
  reported bearer authentication and Claude reported `connected`. The selected
  Super Agent has `connections: []`, so both correctly exposed zero tools; the
  terminal E2E fixture separately proves that the scoped bearer reaches only
  the exact selected MCP path (200), while a different MCP path and private API
  routes are rejected (401).
- That MCP pass exposed one local-TLS edge case: multiple app namespaces can
  leave trusted development roots with the same subject in the macOS Keychain.
  Claude initially selected a stale issuer and reported
  `CERT_SIGNATURE_FAILURE`. Native leaf certificates now include an Authority
  Key Identifier, making issuer selection deterministic; the local-TLS unit
  suite and a second real Claude `/mcp` pass verified the fix.
- At the time of this two-provider pass, provider availability and direct
  launch required Claude Code 2.1.218 and Codex CLI 0.144.5. The subsequent
  OpenCode extension additionally requires OpenCode 1.18.10. Black-box stale-
  request coverage proves an unsupported CLI fails with upgrade guidance
  before the harness is pinned, leaving the fresh-chat picker intact.
- Terminal metadata returned the persisted opaque thread-generation fence.
  The final schema contained no executable queue table or queue API; v10 queue
  rows remained only in the non-executing legacy archive. Native autosend
  allowed one persisted retry and exhausted it after the second definitive
  rejection, including across renderer remounts.
- The accessibility snapshot reported both provider chats as `Status: Done`
  and one labeled terminal surface with no Studio terminal toolbar or actions.
  A rendered-DOM scan found no bearer,
  API-token, or 64-hex credential pattern. Console capture contained no runtime
  error or secret; only the development MCP transport fallback and the existing
  router-context warning were present.
- Graceful native shutdown persisted both active rows as exited/interrupted
  with signal exit code 143 and reaped the CLI, terminal anchors, watchdogs,
  and debug app. The four isolated NFS test mounts were explicitly unmounted;
  the installed production app remained running.

Captured UI evidence:

- `/tmp/studio-native-picker-1440.png`
- `/tmp/studio-native-claude-result.png`
- `/tmp/studio-native-codex-success.png`
- `/tmp/studio-native-final-codex-resume-ok.png`
- `/tmp/studio-native-final-claude-resume-ok.png`
- `/tmp/studio-native-final-codex-mcp-connected.png`
- `/tmp/studio-native-final-claude-mcp-connected.png`
- `/tmp/studio-native-hardened-codex-result.png`
- `/tmp/studio-native-hardened-claude-result.png`

Automated validation completed with no failures:

- `cargo test --workspace --all-features`
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- the native cutover and embedded terminal E2E suites (6 scenarios, 86
  assertions), including Claude Code, Codex, and OpenCode terminal lifecycle
  scenarios
- 85 focused agent-selection and terminal frontend tests (274 assertions)
- the isolated repository unit suite (6,607 tests across 730 files)
- `bun run check`, `bun run lint`, `bun run knip`, and `bun run fmt:check`
- hosted and native production builds, including the terminal-marker boundary
  check that keeps native protocol code out of the hosted bundle

## OpenCode stacked validation record (2026-08-01)

The OpenCode pass used the Tauri DevTools MCP bridge against the isolated
`com.decocms.studio.opencodetest2` debug namespace. OpenCode used a temporary,
owner-only XDG data root with a symlink to the existing auth file; Studio never
opened or modified the user's existing OpenCode database, and the temporary
data roots were deleted after shutdown.

- The availability gate rejected the installed OpenCode 1.18.10 runtime when
  its existing database could not complete the bounded plugin-free
  `--pure db 'SELECT 1'` check. The same binary became available against a
  healthy isolated database, proving the picker does not launch a known-broken
  runtime into a blank terminal.
- A fresh chat rendered Claude Code, Codex, and OpenCode choices with no legacy
  composer, message list, queue tray, or cloud model picker. Selecting OpenCode
  spawned its real TUI, showed the launch-unique Studio agent, retained
  provider-owned model selection, and reported the selected `cms` MCP.
- The real OpenCode TUI accepted a prompt and returned exactly
  `OPENCODE_NATIVE_OK` through xterm. The sidebar reached `Done`, OpenCode
  returned to its input prompt in xterm, and its provider title updated the chat
  to `Simple command response verification`.
- After a full app shutdown and restart, reopening that chat spawned
  `opencode --agent <new-launch-id> --session <exact-stored-provider-id>`.
  The transcript replayed `OPENCODE_NATIVE_OK` without resending the prompt,
  the generated title remained, and the terminal was ready for new input.
- The final rendered DOM contained no bearer, 64-hex credential, hook-token
  variable, or MCP authorization variable. Console capture contained no
  runtime error or secret; only the known development Tauri IPC fallback
  warning appeared.
- Graceful shutdown reaped both the active and detached OpenCode process trees.
  No OpenCode process, native listener, or isolated org mount remained.

Captured OpenCode UI evidence:

- `/tmp/studio-native-opencode-picker-final.png`
- `/tmp/studio-native-opencode-result.png`
- `/tmp/studio-native-opencode-resumed.png`

## Tauri DevTools MCP release gate

The debug Tauri app already registers `tauri-plugin-mcp-bridge`. Release UI
validation starts the real app with `bun run --cwd=apps/native dev`, connects
through `@hypothesi/tauri-mcp-server`, and uses its webview automation,
screenshots, console, and inspection tools rather than relying only on browser
Playwright.

Required driven scenarios:

1. Open a fresh thread and capture the Claude Code/Codex/OpenCode picker. Confirm no composer,
   message bubbles, queue tray, or cloud-provider picker exists.
2. Choose Claude Code. Confirm exactly one process starts and xterm replaces the
   picker, with no Studio toolbar, lifecycle label, error banner, or action
   buttons around it. Repeat with Codex and OpenCode in separate threads.
3. Type, paste multiline text, use arrows/backspace/Ctrl-C, and operate native
   permission/question prompts through real input events.
4. Resize the side panel, main window, and narrow/mobile layout. Confirm cursor,
   rows, columns, and focus remain correct.
5. Observe sidebar transitions through idle, `in_progress`,
   `requires_action`, completed, and failed states while the PTY stays alive.
6. Submit the first prompt, observe fallback/generated title, then race a manual
   rename and confirm it wins.
7. Inspect network/WS activity: terminal socket plus `/api/:org/watch`, with no
   native Decopilot message/stream/queue/cancel calls.
8. Hide/reopen the side panel, switch tasks, and reload the webview. Confirm the
   same live process reattaches without duplicate or missing output.
9. Exercise two thread/branch sessions and confirm isolated cwd, output,
   sidebar state, and process identity.
10. Invoke a real Virtual MCP tool from every provider and confirm the correct
    org/sandbox effect.
11. Create/edit a file from the TUI and confirm file explorer, git diff, branch,
    and preview integration update.
12. Produce sustained output past replay thresholds and confirm responsive UI,
    bounded storage, and deterministic reconnect behavior.
13. Kill the CLI externally, retry/resume, delete a running thread, and quit the
    app. Confirm status and full process-tree cleanup.
14. Hide/remove each CLI in turn. Confirm the setup state and absence of hosted
    fallback.
15. Inspect console, DOM, terminal, frames, and errors for tokens, cookies, MCP
    headers, hook tokens, or raw secret configuration. None may appear.

Capture screenshots for picker, running, waiting, failed, reattached, and
missing-runtime states. Final handoff includes screenshots, console/network
findings, and confirmation that there are no unexpected console errors or
orphan processes.

## Verification commands

Run targeted checks continuously, then the full repository gates before review:

```bash
cargo test --manifest-path apps/native/Cargo.toml
bun run --cwd=apps/native check
bun run --cwd=apps/native e2e
bun run --cwd=apps/web build:web
bun run --cwd=apps/web build:native
bun run check
bun run lint
bun test
bun run fmt
bun run fmt:check
```

Run the final Tauri DevTools MCP scenarios against a debug build after these
automated checks pass.

## Definition of done

- Fresh native threads use the Claude Code/Codex/OpenCode picker and start the chosen
  real interactive CLI.
- Native shows xterm only; no legacy native chat UI or AI SDK transport runs.
- Hosted web chat behavior and test expectations are unchanged.
- System instructions, org filesystem context, and the selected Virtual MCP are
  injected without leaking secrets.
- Hook-driven sidebar status, titles, and provider resume work for every
  provider.
- PTYs survive view detach/reconnect but are reaped on every ownership-ending
  lifecycle.
- Legacy queued prompts are preserved but never executed; stale native chat
  endpoints fail closed.
- Automated Rust, native E2E, web, type, lint, format, and unit gates pass.
- Tauri DevTools MCP drives and captures the final real UI scenarios with no
  unexpected console errors, secret exposure, or orphan processes.
