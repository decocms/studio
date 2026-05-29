# Unified CLI TUI + `link` Task-Manager View — Design

**Date:** 2026-05-29
**Status:** Approved (pending implementation plan)
**Area:** `apps/mesh/src/cli/`, `apps/mesh/src/link-daemon/`, `apps/mesh/src/cli.ts`, `apps/mesh/src/fmt.ts`

## Problem

The `decocms` CLI (bin `deco`, package `decocms`) renders an Ink TUI only for the
`serve` (default) and `dev` commands. Three problems:

1. **No shared visual identity.** The "DECO" ASCII banner is duplicated in two
   places — `cli/header.tsx` (`ASCII_LINES` + `GRADIENT_COLORS`, Ink) and
   `fmt.ts` (`ASCII_ART`, plain ANSI). `auth`, `link`, `init`, `services`,
   `completion` print plain text with no banner at all.
2. **`link` has no live view.** The desktop link daemon streams raw
   `[user-desktop] …` `console.log` lines. The provider already tracks rich
   per-sandbox state (`handle`, `port`, `previewUrl`, `activeDispatchCount`,
   `lastUsedAt`) via `listSandboxes()`, but none of it is surfaced as status.
3. **Fragile TUI internals.** `request-log.tsx` slices the log list to
   `rows - headerHeight - 1` using `useTerminalSize`, which breaks on terminals
   that misreport size. The `--vibe` synthwave/capybara mode and the `L`
   log-flow toggle add surface area we want to drop.

## Goals

- One source of truth for the banner art, consumed by both an Ink component and
  a plain printer.
- A consistent `--no-tui` contract across all long-running commands.
- A live task-manager TUI for `link` that renders daemon + sandbox **statuses and
  ports** instead of the raw console.
- Remove vibe mode, the `L` toggle, and the terminal-height log windowing.

## Non-Goals

- No banner on quick utility commands (`auth whoami`, `services status`,
  `init`, `completion`). `completion` MUST stay banner-free — its output is
  `eval`'d into the user's shell.
- No `<Static>`-based scrollback. The request log becomes a plain growing list
  (see §3). `<Static>` is noted only as a future upgrade path.
- No changes to sandbox lifecycle/eviction behavior — the new events are purely
  additive observability.

## Design

### 1. Shared banner (single source of truth)

New module `apps/mesh/src/cli/banner.tsx` owns the art once:

- `BANNER_LINES: string[]` — the raw "DECO" glyph rows.
- `BANNER_GRADIENT: string[]` — green gradient, one color per row (parallel to
  `BANNER_LINES`).
- `printBanner(version: string)` — plain path: writes the gradient art followed
  by `v<version>` via ANSI truecolor. Replaces `fmt.ts`'s `ASCII_ART`.
- `<Banner version />` — Ink path: maps `BANNER_LINES` × `BANNER_GRADIENT` into
  `<Text color>` rows. Replaces `header.tsx`'s inline `ASCII_LINES` /
  `GRADIENT_COLORS`.

`fmt.ts` keeps `dim`; its `ASCII_ART` export is removed and the call sites in
`cli.ts` switch to `printBanner`.

### 2. Unified TUI / `--no-tui` contract

A single shared helper — `resolveTui(values)` returning a boolean — used by
**`serve`, `dev`, and `link`**. TUI is **off** when `--no-tui` is passed **or**
`!process.stdout.isTTY` (CI, pipes).

- **Plain mode:** `printBanner(version)` once, then normal `console.log` output
  flows straight through (today's server/daemon logs, including the daemon's
  `[user-desktop]` lines).
- **TUI mode:** render the Ink shell; intercept `console.log` so stray writes
  cannot corrupt the render (`serve` already does this via
  `interceptConsoleForTui`).

`link` starts honoring `--no-tui`; today it ignores the flag entirely.

### 3. `serve` / `dev` cleanup

**Remove vibe entirely:**
- `--vibe` flag and its help-text lines in `cli.ts`.
- Files: `cli/vibe/vibe-player.ts`, `cli/vibe/playlist.json`,
  `cli/capy-frames.ts`, `cli/capy-animation.ts`, `cli/matrix-rain.ts`.
- The vibe branch in `header.tsx` (capy frames + matrix rain rendering).
- `vibe`, `setVibe`, `toggleVibeState` in `cli-store.ts`.
- The `V` / `N` key handlers in `app.tsx`.

**Remove the `L` toggle:**
- `logFlow`, `toggleLogFlow` in `cli-store.ts`.
- The `L` key handler in `app.tsx` and the "L toggle log flow" hint in
  `header.tsx`.

**Remove the `K` toggle and the config view entirely:**
- `config-view.tsx` (and its test, if any) — deleted.
- `viewMode`, `env`, `setEnv`, `toggleViewMode` in `cli-store.ts`.
- The `setEnv(settings)` calls in `commands/serve.ts` (`:93`) and
  `commands/dev.ts` (`:116`).
- The `K` key handler and the `viewMode` branch in `app.tsx` — `App` now
  renders only `<Banner>` + status header + `RequestLog`. With no remaining key
  handlers, the `useInput` block is removed (and with it the "K toggle config"
  hint in `header.tsx`).
- Net result: the only Ink shells with key input are gone; `serve`/`dev` render
  a static banner + status + growing request log.

**Remove auto-scroll height:**
- `request-log.tsx` maps the **full** log list — no `useTerminalSize`, no
  `headerHeight` prop, no slicing.
- `app.tsx` drops the `HEADER_HEIGHT` / `HEADER_HEIGHT_VIBE` constants and the
  `headerHeight` prop wiring.
- `cli/use-terminal-size.ts` is deleted if it has no remaining consumers.

Tradeoff (accepted): the log list stays inside Ink's dynamic render region, so
Ink redraws the whole list on each new entry. Fine for normal sessions; can
flicker on very long ones. `<Static>` remains the future upgrade path.

### 4. New `link` task-manager view

**Provider** (`link-daemon/user-desktop-provider.ts`) gains an optional
`onEvent?: (e: SandboxEvent) => void` dependency:

```ts
type SandboxPhase =
  | "spawning" | "ready" | "failed" | "evicted" | "deleted";

interface SandboxEvent {
  handle: string;
  phase: SandboxPhase;
  port?: number;
  previewUrl?: string;
  error?: string;            // set on "failed"
  activeDispatchCount?: number;
}
```

Emitted at each lifecycle transition: spawn start (`spawning`), healthy + config
posted (`ready`), bring-up failure (`failed` with the error message), LRU
eviction (`evicted`), explicit delete (`deleted`), and dispatch acquire/release
(`ready` with updated `activeDispatchCount`). The existing `sandboxes` /
`inflight` maps are **untouched** — events are additive and never alter control
flow.

**Store** `apps/mesh/src/cli/link-store.ts` — external store mirroring
`cli-store`'s shape (module-scoped state + `Set` of listeners + `getState` /
`subscribe`, consumed via `useSyncExternalStore`, no `useEffect`):
- Cluster status (`connecting` | `linked` | `closed`), ingress port + URL,
  machine label (`hostname · N sandboxes / cap`).
- `Map<handle, SandboxRow>` accumulated from `SandboxEvent`s. `failed` rows
  **linger with their error** until the next `ensure` for that handle (or a
  `deleted` event); `evicted` / `deleted` drop the row immediately.
- A one-line daemon-level error (cluster drop, ingress bind failure).

**View** `apps/mesh/src/cli/link-app.tsx` — Ink component:
- `<Banner version />`.
- Status block: `Cluster`, `Ingress`, `Machine` rows with ✓/◌ indicators.
- Sandbox table: `HANDLE  PORT  STATUS  ACTIVE  IDLE  PREVIEW`, one row per
  sandbox. `STATUS` shows `● ready` / `◌ spawning` / `✗ failed: <error>`.
- A one-line footer for the latest daemon-level error.
- A 1 Hz timer re-renders **only** the relative `IDLE` times (e.g. `3m`); all
  structural changes are event-driven (this is not provider polling).

**`cli.ts` `link` branch:** call `resolveTui`. In TUI mode, render `link-app`
and wire the daemon's `onEvent` → `link-store`; in plain mode, keep today's
`console.log` daemon untouched.

### 5. Testing

Two tiers only (per `TESTING.md`): unit (pure logic) and e2e (everything else).

- **Unit:**
  - `banner` — `BANNER_LINES.length === BANNER_GRADIENT.length`; `printBanner`
    output contains the version and the expected line count.
  - `link-store` — reduce known `SandboxEvent` sequences and assert the
    resulting rows: `spawning → ready → dispatch` count updates, `failed`
    retention until next `spawning`, `evicted` / `deleted` removal.
  - `resolveTui` — flag/TTY matrix (`--no-tui` true, non-TTY, normal TTY).
- **Provider event emission** — extend the existing provider test (its fakes
  already drive the spawn/health/fail lifecycle) to assert `onEvent` fires with
  the right phases.
- **No e2e** — these are pure-logic and render-data units; no DB/network.

## File Inventory

**New:**
- `apps/mesh/src/cli/banner.tsx`
- `apps/mesh/src/cli/link-store.ts`
- `apps/mesh/src/cli/link-app.tsx`
- `apps/mesh/src/cli/banner.test.ts`, `link-store.test.ts`, and a
  `resolveTui` test (location per where the helper lands).

**Modified:**
- `apps/mesh/src/cli.ts` — `resolveTui` helper, `link` TUI wiring, remove
  `--vibe`, switch banner printing to `printBanner`.
- `apps/mesh/src/fmt.ts` — remove `ASCII_ART`, keep `dim`.
- `apps/mesh/src/cli/header.tsx` — use `<Banner>`, drop vibe branch + `L`/`K`
  hints.
- `apps/mesh/src/cli/app.tsx` — drop vibe/`L`/`K` handlers, the `useInput`
  block, the `viewMode` branch, and `HEADER_HEIGHT*`.
- `apps/mesh/src/cli/cli-store.ts` — drop `vibe`/`logFlow`/`viewMode`/`env`
  state + their setters (`setVibe`, `toggleVibeState`, `toggleLogFlow`,
  `setEnv`, `toggleViewMode`).
- `apps/mesh/src/cli/commands/serve.ts`, `commands/dev.ts` — remove `setEnv`
  call + import.
- `apps/mesh/src/cli/request-log.tsx` — full list, no windowing.
- `apps/mesh/src/link-daemon/user-desktop-provider.ts` — `onEvent` emission.
- `apps/mesh/src/link-daemon/index.ts` — accept/forward `onEvent`.

**Deleted:**
- `apps/mesh/src/cli/vibe/vibe-player.ts`, `apps/mesh/src/cli/vibe/playlist.json`
- `apps/mesh/src/cli/capy-frames.ts`, `capy-animation.ts`, `matrix-rain.ts`
- `apps/mesh/src/cli/use-terminal-size.ts` (if no remaining consumers)
- `apps/mesh/src/cli/config-view.tsx`

## Open Questions

None outstanding. Confirmed: remove the `K` toggle **and** the config view
entirely; failed sandbox rows linger with their error until next
`ensure`/delete.
