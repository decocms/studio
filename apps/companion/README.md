# Deco Companion

A tiny native desktop app (Vercel **Native SDK** — Zig host + React WebView)
that maps your Studio orgs into Claude Code as MCP servers. Download, run, and
click **Sync** — no terminal, no config editing.

## What it does

- **Inbound (this app's core):** calls Studio's `POST /api/companion/provision`
  with your `deco link` session token, gets back one Decopilot MCP per org, and
  **surgically merges** them into `~/.claude.json` under `mcpServers` as
  `deco-<slug>` entries — preserving every other server and top-level key. Writes
  atomically (temp + rename) and keeps a `.deco-bak` backup.
- **Outbound (planned):** run the bundled `deco link` daemon so your local
  Claude/Codex become AI providers for your orgs. The daemon bundles cleanly as a
  standalone binary (see `apps/mesh` CLI) and is spawned by the host — not yet
  wired into this app.

## Architecture

- `src/main.zig` — the App + the `deco.*` bridge commands (`window.zero.invoke`).
- `src/claude_config.zig` — the surgical `~/.claude.json` merge (unit-tested).
- `src/studio_api.zig` — reads the session token; calls the provisioning
  endpoint via `curl` (keeps the token out of JS, avoids CORS).
- `frontend/` — React UI (`bridge.ts` wraps `window.zero.invoke`).

The bridge is sync: JS `window.zero.invoke("deco.provision")` → Zig handler →
JSON result. `curl` + file IO run on the host, never in the WebView.

## Run

```bash
# toolchain: Zig 0.16 + the Native SDK CLI
brew install zig
npm install -g @native-sdk/cli

cd apps/companion
(cd frontend && npm install)
native dev          # or: zig build run
```

Point at a non-prod Studio with `DECO_STUDIO_URL=http://localhost:<port>`.

## Environment overrides

| Var | Default | Purpose |
|---|---|---|
| `DECO_STUDIO_URL` / `MESH_CLUSTER_URL` | `https://studio.decocms.com` | Studio to provision against |
| `DATA_DIR` / `DECOCMS_HOME` | `~/deco` | where the `session.*.json` lives |
| `DECO_CLAUDE_CONFIG` | `~/.claude.json` | config file to merge into |
| `DECO_COMPANION_HEADLESS` | (unset) | `status` or `provision` → run that flow and print JSON, no window |

## Tests

```bash
zig test src/claude_config.zig     # surgical-merge unit tests
```

Headless E2E (no GUI) against a mock or real server:

```bash
DECO_COMPANION_HEADLESS=provision \
  DECO_STUDIO_URL=http://localhost:8899 \
  DATA_DIR=/tmp/data DECO_CLAUDE_CONFIG=/tmp/claude.json \
  ./zig-out/bin/companion
```

## Notes

- `build.zig`'s `default_native_sdk_path` points at the globally-installed
  `@native-sdk/cli`. Override with `-Dnative-sdk-path=…` if the SDK lives
  elsewhere.
- Decoupled from the Bun workspace (no root `package.json`), like the old
  `apps/launcher`.
