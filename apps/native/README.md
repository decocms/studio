# Studio Native

Packages the existing Studio web application as a Tauri desktop app with a
local Rust runtime.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/native` (`apps/native`) |
| Kind | Tauri desktop application and local runtime |
| Runtime | Rust, WebKit, and the bundled React application |
| Distribution | Private workspace package; signed macOS application (Apple Silicon) and Linux x86_64 AppImage |

## Overview

Studio Native embeds the production `apps/web` UI without forking its product
shell. An in-process Axum server serves the bundled UI and native API from one
stable loopback origin, proxies upstream Studio requests, and intercepts the
local-only thread, harness, sandbox, filesystem, Git, task, and preview
surfaces.

Releases target macOS on Apple Silicon (`.app` and DMG) and Linux x86_64
(AppImage), both served by one self-update channel. The Rust crates and
browser contracts are kept portable so Windows can be added without
redesigning the application boundary.

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

### Native terminal performance

Native terminals use bounded cooperative xterm writes, parse-confirmed output
credit, raw binary PTY output frames, and WebGL2 rendering with automatic DOM
fallback. Run `bun run --cwd=apps/web benchmark:terminal` for the repeatable
synthetic scheduler baseline. The native terminal WebSocket E2E separately
asserts that unparsed output is bounded and resumes after a cumulative ACK.

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
`LOCAL_API_E2E_CMD`. Terminal-agent tests use deterministic interactive Claude
Code and Codex fixtures to prove PTY behavior, scoped MCP and hook
capabilities, persisted provider-session resume, and that an accepted prompt
is never replayed after restart.

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

One channel serves both shipping targets. `latest.json` carries one entry per
platform key, each pointing at an asset of the immutable `native-v<version>`
release:

| Platform key | Updater asset (plus its `.sig`) |
| --- | --- |
| `darwin-aarch64` | `deco-<version>-aarch64.app.tar.gz` |
| `linux-x86_64` | `deco-<version>-linux-x86_64.AppImage.tar.gz` |

### Promotion is all-platforms-or-nothing; publication is not

A manifest missing a platform key silently strands that platform's installed
base, so the channel moves only when **every** key's assets are on the
release. Three gates enforce that: `promote` runs only if the whole `build`
matrix succeeded; it verifies each expected asset name against the release's
asset list before building anything; and the manifest builder refuses to emit
a manifest with a missing or empty signature, or one covering fewer platforms
than the currently-published manifest.

**Publication is deliberately not held back the same way.** `publish` runs
even when a build leg failed and creates or updates the release from whatever
assets arrived; the Homebrew cask bump is gated only on the macOS assets being
present. So a red Linux leg means:

- macOS distribution is unaffected: the release (zip, DMG, updater tarball)
  publishes and the cask bumps, so `brew install --cask deco-studio` and
  `install.sh` keep serving the new version.
- The update channel freezes at the previous version **for every platform**,
  macOS included. Installed apps keep running what they have, and version
  drift is suppressed in the shell by design — the only signal is the issue
  the `alert` job files.

Repair: fix the leg, then re-run `release-native.yaml` via `workflow_dispatch`
on the same version. A dispatch does not skip an existing tag; assets under a
`native-v*` tag are write-once, so `publish` uploads only the ones the release
is missing (builds are not reproducible — replacing bytes under an
already-published signature would break both self-update and the cask's pinned
`sha256`); `promote` then sees a complete set. Pass `force_promote` to bypass
the ~daily throttle. Do not dispatch from a ref that predates a platform: the
superset check fails the run rather than publishing a manifest that drops
`linux-x86_64`.

Operator notes:

- **Signing key** (`TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD`, GitHub
  environment `native-release`): one keypair signs every platform's updater
  artifact, and the public key is pinned in `src-tauri/tauri.conf.json5`.
  Losing the private key permanently strands the installed base on the
  updater, and break-glass differs per platform:
  - macOS: the Homebrew cask (`brew upgrade --greedy --cask deco-studio`), so
    the CI cask bump must keep working forever.
  - Linux: **there is no cask equivalent.** Recovery is users re-downloading
    `deco-<version>-linux-x86_64.AppImage` from the `native-v<version>`
    release page and `chmod +x`-ing it. Nothing can be pushed to a Linux
    install — plan announcements accordingly.

  A leaked key has no revocation: rotation = new keypair + a forced reinstall
  on both platforms.
- **Bad release**: the updater never downgrades. Ship a newer fixed release;
  use the `force_promote` dispatch input of `release-native.yaml` to bypass
  the ~daily channel throttle. An install too broken to launch recovers by
  cask reinstall on macOS and by re-downloading the AppImage on Linux.
- **Kill switch**: `DECOCMS_DISABLE_AUTO_UPDATE=1` disables the updater task
  on both platforms, unchanged (warn-logged every cycle). It has to reach the
  process environment: a Finder-launched macOS app does not inherit shell env
  — use `launchctl setenv DECOCMS_DISABLE_AUTO_UPDATE 1` or a terminal launch;
  on Linux prefix the AppImage itself
  (`DECOCMS_DISABLE_AUTO_UPDATE=1 ./deco-<version>-linux-x86_64.AppImage`),
  since a desktop-launched app inherits only the graphical session's
  environment.
- **Linux self-updates only from an AppImage**: the updater plugin rewrites
  the file `$APPIMAGE` points at, in place, so with that variable unset (dev
  build, extracted AppDir, any future deb/rpm) the task never spawns and there
  is no way to turn it on.

## Related documentation

- [Studio Web](../web/README.md)
- [Studio API](../api/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
