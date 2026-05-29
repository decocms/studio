# `deco link` TUI corruption fixes

**Date:** 2026-05-29
**Status:** Approved (design)
**Scope:** Two bugs in the `bunx decocms link` desktop daemon TUI.

## Problem

Running `bunx decocms link` renders an Ink "task-manager" TUI (cluster status,
ingress URL, a per-sandbox preview table). Two defects corrupt that view:

1. **Child daemon output leaks onto the canvas.** Lines like
   `[daemon] [daemon] … proxy GET /_next/static/...` paint directly over the
   Ink render. Root cause: `createDefaultDaemonSpawn`
   (`packages/sandbox/server/daemon-spawn.ts:107-108`) spawns each sandbox
   daemon with `stdout: "inherit"` / `stderr: "inherit"`, wiring the child's
   output straight to the parent's terminal fds. `interceptLinkConsole`
   (`apps/mesh/src/cli/commands/link.ts:37-53`) only patches the parent
   process's JS `console.*` methods — it cannot intercept a separate child
   process writing to an inherited fd, so child output bypasses it entirely.

2. **The preview table columns overflow and collide.** The header pads
   `"PROJECT".padEnd(16)` (`apps/mesh/src/cli/link-app.tsx:93`) but each row
   pads `row.handle.padEnd(16)` (`link-app.tsx:103`). `String.padEnd` never
   *truncates*, so a 29-char handle such as `tender-delta-9a01046650d875c9`
   overflows the 16-wide column and butts directly against the next column's
   `● Live` with no gutter:
   `tender-delta-9a01046650d875c9● Live`. The same latent overflow exists for
   any long cell (e.g. a long `✗ Error: …` status string).

## Goals

- Child daemon output no longer corrupts the TUI; it is preserved in a log
  file on disk for debugging.
- The preview table keeps stable, aligned columns regardless of content
  length, truncating over-long inner data with an ellipsis.
- No regression for `--no-tui` mode or the managed/dev daemon (their output is
  meant to stream to the parent).
- No new third-party dependency.

## Non-goals

- Reworking the reconnect/backoff loop (tracked separately as a higher-severity
  bug — out of this scope).
- Changing what lifecycle information the TUI displays (columns, status
  semantics) beyond fixing alignment.

---

## Design

### Fix 1 — route all `deco link` logs to `<dataDir>/link.log`

A single combined log file, opened by the command layer (which already
orchestrates both the console interception and the daemon), and shared by:
(a) the parent process's intercepted `console.*`, and (b) every spawned child
sandbox daemon's stdout/stderr.

**`packages/sandbox/server/daemon-spawn.ts`**

Add a backward-compatible option to the factory (the only caller is the link
daemon, so the default preserves all current behavior):

```ts
export function createDefaultDaemonSpawn(
  homeDir: string,
  opts: { outFd?: number } = {},
): SpawnDaemonFn {
  return async (args) => {
    // …existing exec / NODE_PATH resolution…
    const proc = Bun.spawn({
      cmd: ["bun", "run", daemonExec],
      env: { ...process.env, NODE_PATH: nodePath, ...args.env },
      stdout: opts.outFd ?? "inherit",
      stderr: opts.outFd ?? "inherit",
      stdin: "ignore",
    });
    // …unchanged return…
  };
}
```

- `outFd` undefined (default) → `"inherit"` — unchanged for `--no-tui` and the
  managed/dev daemon.
- `outFd` set → Bun.spawn writes the child's stdout/stderr to that file
  descriptor. The fd is owned and closed by the command layer (below), not by
  the spawn factory — the factory only borrows it for the child's lifetime.

**`apps/mesh/src/link-daemon/index.ts`**

`StartLinkDaemonOptions` gains an optional `logFd?: number`. `startLinkDaemon`
passes it through:

```ts
const innerSpawn = createDefaultDaemonSpawn(opts.dataDir, {
  outFd: opts.logFd,
});
```

**`apps/mesh/src/cli/commands/link.ts`**

In the TUI branch (where `interceptLinkConsole` is already set up), open the
combined log file once and share its fd:

```ts
const logPath = join(dataDir, "link.log");
const logFd = openSync(logPath, "a"); // append; survives restarts
```

- Pass `logFd` to `interceptLinkConsole` so parent `console.*` is **teed to the
  file instead of dropped** (see below), and to `startLinkDaemon({ …, logFd })`
  so children write there too.
- Close the fd in the existing `finally` backstop: `closeSync(logFd)` (guarded
  so a double-close on the error path is harmless).
- Surface the path to the user — a dim line in `LinkApp` showing
  `Logs: <dataDir>/link.log`. The path is provided via the link store
  (`setLogPath(logPath)` / a `logPath` field), mirroring the existing
  `setClusterUrl` / `setIngress` pattern.

**`interceptLinkConsole` rewrite** (`link.ts:37-53`)

Today it discards `console.log`/`console.warn` and routes `console.error` to
the footer. New signature `interceptLinkConsole(onError, logFd?)`:

- `console.log` / `console.warn` → append the formatted line to `logFd`
  (`writeSync(logFd, line + "\n")`) instead of dropping it. No-op if `logFd`
  is undefined (preserves the current "swallow" behavior for any caller that
  omits it).
- `console.error` → append to `logFd` **and** call `onError(msg)` so the latest
  error still shows in the TUI footer.
- The returned restore fn is unchanged.

Result: the terminal canvas stays clean; `<dataDir>/link.log` contains the full
parent (`[user-desktop] …`, ingress/cluster lines) and child (`[daemon] …`)
output, interleaved in append order (POSIX `O_APPEND` writes are atomic per
write, so lines don't tear).

### Fix 2 — fixed-width, truncating table columns (Ink-native)

`ink-table` is **not** installed and carries React-19 / ink-6 peer-compat
risk. Ink 6 already exposes the needed primitive: a fixed-width `<Box>` whose
inner `<Text wrap="truncate-end">` truncates with an ellipsis. Confirmed in
`apps/mesh/node_modules/ink/build/components/Text.d.ts` (the `wrap` prop accepts
`"truncate-end"`).

**`apps/mesh/src/cli/link-app.tsx`**

Define column widths once and use them for both the header and every row, so
they can never drift:

```ts
const COLS = {
  project: 18,
  status: 14,
  requests: 10,
  lastUsed: 11,
} as const;
```

Each non-final column:

```tsx
<Box width={COLS.project} flexShrink={0}>
  <Text wrap="truncate-end">{row.handle}</Text>
</Box>
```

- Status column keeps its color on the inner `<Text>` and now truncates long
  `✗ Error: …` strings cleanly instead of overflowing.
- PREVIEW URL is the final column → `<Box flexGrow={1}>` with
  `<Text wrap="truncate-end" dimColor>`; nothing follows it, and it still shows
  the full handle as the subdomain.
- The header row uses the same `COLS` widths with `<Text dimColor>` labels.

This removes all manual `padEnd` calls from the table. Alignment is guaranteed
by the layout engine regardless of content length.

---

## Files touched

| File | Change |
|------|--------|
| `packages/sandbox/server/daemon-spawn.ts` | Add `{ outFd?: number }` option to `createDefaultDaemonSpawn`; use it for `stdout`/`stderr`. |
| `apps/mesh/src/link-daemon/index.ts` | Add `logFd?` to `StartLinkDaemonOptions`; pass `outFd` into the spawn factory. |
| `apps/mesh/src/cli/commands/link.ts` | Open `<dataDir>/link.log`; tee intercepted console to it; pass `logFd` to daemon; close on exit. Update `interceptLinkConsole` signature. |
| `apps/mesh/src/cli/link-store.ts` | Add `logPath` field + `setLogPath` setter. |
| `apps/mesh/src/cli/link-app.tsx` | Replace `padEnd` table with `<Box width>` + `<Text wrap="truncate-end">` columns; add `Logs:` hint line. |

## Testing

- **Unit (`daemon-spawn`)**: assert that with `{ outFd: <fd> }` the spawn config
  uses the fd for stdout/stderr, and that the default still resolves to
  `"inherit"`. (Pure option-mapping; real child spawning is e2e.)
- **Unit (`link-store`)**: existing `applySandboxEvent` tests unaffected; add a
  trivial `setLogPath` round-trip if it fits the existing store test style.
- **Manual / e2e**: run `bunx decocms link`, open a preview with a long
  (29-char) handle, and confirm:
  1. No `[daemon] … proxy GET …` lines paint over the TUI.
  2. `<dataDir>/link.log` exists and contains both parent and child output.
  3. Table columns stay aligned; the long handle truncates with `…`; the full
     handle is visible in the PREVIEW URL column.
  4. `bunx decocms link --no-tui` still streams daemon logs to the terminal
     (no regression).

## Decisions / alternatives considered

- **Single combined `link.log` vs. per-sandbox `sandboxes/<handle>/daemon.log`.**
  Chose the single combined file: matches the request ("a log file"), is the
  simpler `tail -f` target, and lets the parent's own console output share the
  same file. Per-sandbox files were the isolated alternative but fragment the
  logs and don't capture parent output.
- **Suppress (`"ignore"`) vs. file vs. pipe-to-footer for child output.**
  Chose file: preserves logs for debugging (suppress loses them) without the
  line-buffering/stream-plumbing of piping into the footer.
- **`ink-table` plugin vs. native `<Box>`/`<Text wrap>`.** Chose native: no new
  dependency, no React-19/ink-6 peer-compat risk, and it's the documented Ink
  idiom for fixed-width truncating columns.
