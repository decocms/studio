# Studio Native

Packages the existing Studio web application as a Tauri desktop app with a
local Rust runtime.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/native` (`apps/native`) |
| Kind | Tauri desktop application and local runtime |
| Runtime | Rust, WebKit, and the bundled React application |
| Distribution | Private workspace package; signed macOS application |

## Overview

Studio Native embeds the production `apps/web` UI without forking its product
shell. An in-process Axum server serves the bundled UI and native API from one
stable loopback origin, proxies upstream Studio requests, and intercepts the
local-only thread, harness, sandbox, filesystem, Git, task, and preview
surfaces.

The current release targets macOS. The Rust crates and browser contracts are
kept portable so Windows can be added without redesigning the application
boundary.

## Responsibilities

- Start and supervise the local Rust API inside the Tauri process.
- Serve the native Vite bundle and API from one `localhost` origin.
- Authenticate local control requests with an HttpOnly `SameSite=Strict`
  cookie.
- Store upstream Studio sessions in the operating-system credential store.
- Detect and run the user's Claude Code and Codex installations.
- Persist native threads and provider session identifiers in SQLite.
- Create, recover, start, stop, and restart local Git-backed sandboxes.
- Retain subprocess output in bounded files and replay their tails to xterm.js.
- Proxy sandbox previews without stripping the sandbox application's cookies or
  authorization headers.

## Usage

From the repository root, install dependencies and start the native HMR loop:

```bash
bun install
bun run --cwd=apps/native dev
```

The command starts native-mode Vite from `apps/web` on
`http://localhost:4420`, builds and launches the Rust shell, and proxies native
control routes to the embedded API.

Build the native web bundle independently with:

```bash
bun run --cwd=apps/web build:native
```

Build the Tauri application with:

```bash
bunx tauri build --config apps/native/src-tauri/tauri.conf.json5
```

## Architecture

```text
Tauri window
    |
    v
http://localhost:<control-port>
    |
    +-- bundled apps/web UI
    +-- local control API
    +-- upstream Studio proxy ----> studio.decocms.com
    +-- sandbox preview proxy ----> user dev server
    |
    +-- SQLite threads and sandbox registry
    +-- Keychain session
    +-- Claude Code / Codex processes
```

Key paths:

| Path | Purpose |
| --- | --- |
| `src-tauri/` | Tauri shell, stable control origin, bundled assets, CSP, and native commands |
| `crates/local-api/` | Axum control API, proxy, thread store, sandbox manager, and setup pipeline |
| `crates/harness/` | Claude Code and Codex detection, process execution, and stream translation |
| `crates/upstream/` | OAuth, token refresh, Keychain access, and upstream session handling |
| `e2e/` | Black-box native API, sandbox, provider-resume, and recovery tests |
| `scripts/` | Dev signing, boot smoke, and release helpers |

The packaged UI is built by `apps/web`; the hosted Hono backend remains in
`apps/api`. Browser-safe contracts shared by both live in `@decocms/shared`.

## Development

Run the focused verification gates from the repository root:

```bash
bun run --cwd=apps/web check
bun run --cwd=apps/api check
bun run --cwd=apps/native check
cd apps/native && cargo fmt --check
cd apps/native && cargo clippy --workspace --all-targets -- -D warnings
cd apps/native && cargo test --workspace
bun run --cwd=apps/native smoke:boot
```

### Dev sessions & the Keychain

On each macOS development machine, create the stable self-signed development
identity once:

```bash
bun run --cwd=apps/native dev:signing:setup
```

The Cargo runner signs each development binary with that identity. This gives
Keychain entries a stable designated requirement across Rust rebuilds, so a
saved Studio session remains readable. The shipped app continues to use its
release signing identity; there is no filesystem token-store fallback.

### Verification matrix

The native E2E suite can run against the built `local-api` binary through
`LOCAL_API_E2E_CMD`. Provider-resume tests use deterministic Claude Code and
Codex fixtures to prove that the persisted provider session ID is reused and
only the newest user message is sent when a run resumes.

Run `bun run fmt` after changes.

## Boundaries

- Keep product UI and user-facing behavior in `apps/web`; native code should
  intercept transport and local capabilities rather than create a second UI.
- Keep hosted Hono routes and server persistence in `apps/api`.
- Keep browser-safe wire contracts in `@decocms/shared`; Rust mirrors those
  contracts at the process boundary.
- Never expose upstream access or refresh tokens to webview JavaScript.
- Do not authorize sandbox preview traffic with the control cookie or rewrite
  its application cookies. Preview requests are a transparent, dedicated
  proxy surface.
- Sandboxes may persist identity and logs, but child processes are always
  re-established after an application restart rather than orphaned.
- Subprocess logs are file-backed and bounded; memory holds only live fan-out.

## Self-update channel (operations)

The packaged app auto-updates via the Tauri updater: it polls `latest.json`
on the rolling `native-updates` GitHub prerelease, which
`release-native.yaml` promotes at most ~daily (unit-tested logic in
`scripts/ci/native-update-channel.mjs`). Design and full rationale:
[`docs/native-updater-plan.md`](./docs/native-updater-plan.md).

Operator notes:

- **Signing key** (`TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD`, GitHub
  environment `native-release`): the public key is pinned in
  `src-tauri/tauri.conf.json5`. Losing the private key permanently strands
  the installed base on the updater — the Homebrew cask is the break-glass
  recovery channel (`brew upgrade --greedy --cask deco-studio`), so the CI
  cask bump must keep working forever. A leaked key has no revocation:
  rotation = new keypair + cask-forced reinstall.
- **Bad release**: the updater never downgrades. Ship a newer fixed release;
  use the `force_promote` dispatch input of `release-native.yaml` to bypass
  the ~daily channel throttle.
- **Kill switch**: `DECOCMS_DISABLE_AUTO_UPDATE=1` disables the updater task
  (warn-logged every cycle). A Finder-launched app does not inherit shell
  env — use `launchctl setenv DECOCMS_DISABLE_AUTO_UPDATE 1` or a terminal
  launch when debugging.

## Related documentation

- [Studio Web](../web/README.md)
- [Studio API](../api/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
