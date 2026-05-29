# `deco link` TUI corruption fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `bunx decocms link` TUI from being corrupted by child-daemon output (route it to `<dataDir>/link.log`) and by overflowing table columns (use fixed-width truncating Ink columns).

**Architecture:** A single combined log file is opened by the CLI command layer and shared by both the parent process's intercepted `console.*` and every spawned sandbox daemon's stdout/stderr (passed as a raw fd into `Bun.spawn`). The preview table is rebuilt with Ink-native `<Box width>` + `<Text wrap="truncate-end">` columns instead of `String.padEnd`.

**Tech Stack:** Bun, TypeScript, Ink 6 (React 19), `bun:test`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/sandbox/server/daemon-spawn.ts` | Spawn sandbox daemons | Add pure `resolveDaemonStdio` helper + `{ outFd? }` option |
| `packages/sandbox/server/daemon-spawn.test.ts` | Test the stdio helper | Create |
| `apps/mesh/src/cli/format-log-line.ts` | Pure console-args→line formatter | Create |
| `apps/mesh/src/cli/format-log-line.test.ts` | Test the formatter | Create |
| `apps/mesh/src/link-daemon/index.ts` | Wire daemon | Thread `logFd` into the spawn factory |
| `apps/mesh/src/cli/link-store.ts` | TUI state store | Add `logPath` field + `setLogPath` |
| `apps/mesh/src/cli/link-store.test.ts` | Store tests | Add `setLogPath` test |
| `apps/mesh/src/cli/commands/link.ts` | CLI entry / console interception | Open+close log file, tee console, pass `logFd` |
| `apps/mesh/src/cli/link-app.tsx` | Ink TUI view | Rebuild table with truncating columns + `Logs:` hint |

---

## Task 1: `resolveDaemonStdio` helper + `outFd` option in spawn factory

**Files:**
- Modify: `packages/sandbox/server/daemon-spawn.ts:92-120`
- Test: `packages/sandbox/server/daemon-spawn.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox/server/daemon-spawn.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveDaemonStdio } from "./daemon-spawn";

describe("resolveDaemonStdio", () => {
  it("inherits the parent fds when no log fd is given", () => {
    expect(resolveDaemonStdio()).toBe("inherit");
    expect(resolveDaemonStdio(undefined)).toBe("inherit");
  });

  it("returns the provided fd so the child writes to the log file", () => {
    expect(resolveDaemonStdio(7)).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sandbox/server/daemon-spawn.test.ts`
Expected: FAIL — `resolveDaemonStdio` is not exported / not a function.

- [ ] **Step 3: Implement the helper and thread the option**

In `packages/sandbox/server/daemon-spawn.ts`, add this exported helper directly above `createDefaultDaemonSpawn`:

```ts
/**
 * Resolve the stdout/stderr target for the spawned daemon. With no `outFd`
 * the child inherits the parent's terminal fds (the default — used by
 * `--no-tui` and the managed/dev daemon, whose output is meant to stream to
 * the parent). When the `deco link` TUI is active the caller passes a
 * log-file fd so the child's output lands in a file instead of corrupting
 * the Ink canvas.
 */
export function resolveDaemonStdio(outFd?: number): "inherit" | number {
  return outFd ?? "inherit";
}
```

Then change `createDefaultDaemonSpawn` (currently lines 92-120) to accept the option and use the helper. Replace the whole function with:

```ts
export function createDefaultDaemonSpawn(
  homeDir: string,
  opts: { outFd?: number } = {},
): SpawnDaemonFn {
  return async (args) => {
    const daemonExec = await resolveDaemonExec(homeDir);
    const ptyNodeModulesDir = resolveNodePtyNodeModulesDir();
    const existingNodePath = process.env.NODE_PATH;
    const nodePath = existingNodePath
      ? `${ptyNodeModulesDir}:${existingNodePath}`
      : ptyNodeModulesDir;
    const stdio = resolveDaemonStdio(opts.outFd);
    const proc = Bun.spawn({
      cmd: ["bun", "run", daemonExec],
      env: {
        ...process.env,
        NODE_PATH: nodePath,
        ...args.env,
      },
      stdout: stdio,
      stderr: stdio,
      stdin: "ignore",
    });
    return {
      pid: proc.pid,
      kill: (sig) => {
        proc.kill(sig as NodeJS.Signals | number | undefined);
        return true;
      },
      exited: proc.exited,
    };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sandbox/server/daemon-spawn.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox/server/daemon-spawn.ts packages/sandbox/server/daemon-spawn.test.ts
git commit -m "feat(sandbox): add outFd option to createDefaultDaemonSpawn"
```

---

## Task 2: Thread `logFd` through `startLinkDaemon`

**Files:**
- Modify: `apps/mesh/src/link-daemon/index.ts:43-55` (options) and `:72` (spawn factory call)

This is wiring with no pure logic to unit-test; verified by the type checker.

- [ ] **Step 1: Add the `logFd` option to `StartLinkDaemonOptions`**

In `apps/mesh/src/link-daemon/index.ts`, inside the `StartLinkDaemonOptions` interface (after the `monitor?` field, around line 54), add:

```ts
  /**
   * When set, spawned sandbox daemons write stdout/stderr to this file
   * descriptor (the `deco link` log file) instead of inheriting the
   * terminal. Omitted in `--no-tui` / managed mode so their output streams
   * to the parent process.
   */
  logFd?: number;
```

- [ ] **Step 2: Pass it into the spawn factory**

Change line 72 from:

```ts
  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir);
```

to:

```ts
  const innerSpawn = createDefaultDaemonSpawn(opts.dataDir, {
    outFd: opts.logFd,
  });
```

- [ ] **Step 3: Verify it type-checks**

Run: `bun run check`
Expected: PASS (no type errors in `index.ts`). Note: callers not yet passing `logFd` are fine — the field is optional.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/link-daemon/index.ts
git commit -m "feat(link): thread logFd into the sandbox daemon spawn"
```

---

## Task 3: Pure `formatLogLine` helper

**Files:**
- Create: `apps/mesh/src/cli/format-log-line.ts`
- Test: `apps/mesh/src/cli/format-log-line.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/cli/format-log-line.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatLogLine } from "./format-log-line";

describe("formatLogLine", () => {
  it("joins string args with spaces", () => {
    expect(formatLogLine(["a", "b", "c"])).toBe("a b c");
  });

  it("coerces non-string args with String()", () => {
    expect(formatLogLine(["n=", 42, true])).toBe("n= 42 true");
  });

  it("returns an empty string for no args", () => {
    expect(formatLogLine([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/cli/format-log-line.test.ts`
Expected: FAIL — module `./format-log-line` not found.

- [ ] **Step 3: Implement the helper**

Create `apps/mesh/src/cli/format-log-line.ts`:

```ts
/**
 * Format the variadic arguments of a `console.*` call into a single log line
 * (no trailing newline). Mirrors console's space-joining; non-string args are
 * coerced with `String()`. Used to tee intercepted parent console output into
 * the `deco link` log file.
 */
export function formatLogLine(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/format-log-line.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/cli/format-log-line.ts apps/mesh/src/cli/format-log-line.test.ts
git commit -m "feat(link): add formatLogLine helper for console teeing"
```

---

## Task 4: `logPath` field + `setLogPath` setter in the link store

**Files:**
- Modify: `apps/mesh/src/cli/link-store.ts:22-33` (state shape), `:74-83` (initial state), and append a setter
- Test: `apps/mesh/src/cli/link-store.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

In `apps/mesh/src/cli/link-store.test.ts`, change the top import line from:

```ts
import { applySandboxEvent, formatIdle, type SandboxRow } from "./link-store";
```

to:

```ts
import {
  applySandboxEvent,
  formatIdle,
  getLinkState,
  setLogPath,
  type SandboxRow,
} from "./link-store";
```

Then append this describe block at the end of the file:

```ts
describe("setLogPath", () => {
  it("stores the log path on the link state", () => {
    setLogPath("/tmp/deco/link.log");
    expect(getLinkState().logPath).toBe("/tmp/deco/link.log");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/cli/link-store.test.ts`
Expected: FAIL — `setLogPath` is not exported / `logPath` not on state.

- [ ] **Step 3: Implement the field and setter**

In `apps/mesh/src/cli/link-store.ts`:

a) Add `logPath` to the `LinkState` interface (after the `daemonError` field, around line 32):

```ts
  daemonError: string | null;
  /** Absolute path of the combined `deco link` log file (TUI mode only). */
  logPath: string | null;
```

b) Add it to the initial `state` object (after `daemonError: null,`, around line 82):

```ts
  daemonError: null,
  logPath: null,
```

c) Append a setter next to the other setters (after `setDaemonError`, around line 123):

```ts
export function setLogPath(path: string) {
  state = { ...state, logPath: path };
  emit();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/link-store.test.ts`
Expected: PASS (all existing tests + the new `setLogPath` test).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/cli/link-store.ts apps/mesh/src/cli/link-store.test.ts
git commit -m "feat(link): add logPath to the link store"
```

---

## Task 5: Open the log file, tee console, and pass `logFd` (command layer)

**Files:**
- Modify: `apps/mesh/src/cli/commands/link.ts` — imports (`:11-14`), `interceptLinkConsole` (`:37-53`), and `runLinkCommand` (`:83-163`)

No pure logic here (the pure piece is `formatLogLine` from Task 3); verified by the type checker and the manual run in Task 7.

- [ ] **Step 1: Add the needed imports**

In `apps/mesh/src/cli/commands/link.ts`, the current imports are:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon, type LinkDaemonMonitor } from "../../link-daemon";
```

Add `node:fs` and the formatter. Result:

```ts
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon, type LinkDaemonMonitor } from "../../link-daemon";
import { formatLogLine } from "../format-log-line";
```

- [ ] **Step 2: Rewrite `interceptLinkConsole` to tee to the log fd**

Replace the entire `interceptLinkConsole` function (currently lines 37-53) with:

```ts
/**
 * Redirect the parent process's console away from the terminal so it can't
 * corrupt the Ink render. When `logFd` is given, `log`/`warn`/`error` lines
 * are appended to the `deco link` log file; `error` is additionally surfaced
 * in the TUI footer via `onError`. `--no-tui` is the escape hatch for live
 * terminal logs (it never installs this interception).
 */
function interceptLinkConsole(
  onError: (msg: string) => void,
  logFd?: number,
): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const tee = (args: unknown[]): void => {
    if (logFd === undefined) return;
    try {
      writeSync(logFd, `${formatLogLine(args)}\n`);
    } catch {
      // Log file unavailable — never let logging break the daemon.
    }
  };
  console.log = (...args: unknown[]) => tee(args);
  console.warn = (...args: unknown[]) => tee(args);
  console.error = (...args: unknown[]) => {
    tee(args);
    onError(formatLogLine(args));
  };
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}
```

- [ ] **Step 3: Declare `logFd` and open it in the TUI branch**

In `runLinkCommand`, change the declaration line (currently `let restoreConsole: (() => void) | undefined;`, line 97) to also declare the fd:

```ts
  let restoreConsole: (() => void) | undefined;
  let logFd: number | undefined;
```

Then in the `if (opts.tui) {` block, update the dynamic `link-store` import to also pull `setLogPath`, and open the log file. The current block starts at line 117. Replace its body down to the `render(...)` call with:

```ts
    if (opts.tui) {
      const { render } = await import("ink");
      const { createElement } = await import("react");
      const { LinkApp } = await import("../link-app");
      const {
        pushSandboxEvent,
        setCluster,
        setClusterUrl,
        setDaemonError,
        setIngress,
        setLogPath,
        setMachine,
      } = await import("../link-store");

      // Combined log file: both the parent's intercepted console output and
      // every spawned sandbox daemon's stdout/stderr land here, keeping the
      // Ink canvas clean. Append mode so it survives across restarts.
      mkdirSync(dataDir, { recursive: true });
      const logPath = join(dataDir, "link.log");
      logFd = openSync(logPath, "a");
      setLogPath(logPath);

      setClusterUrl(clusterBaseUrl);
      setCluster("connecting");
      monitor = {
        onEvent: (e) => pushSandboxEvent(e),
        onIngress: (p) => setIngress(p, `http://127.0.0.1:${p}`),
        onCluster: (s) => setCluster(s),
        onMachine: (label) => setMachine(label),
      };
      restoreConsole = interceptLinkConsole(setDaemonError, logFd);
      render(createElement(LinkApp), { patchConsole: false });
    } else if (opts.banner !== false) {
```

(The `else if (opts.banner !== false) {` line and everything after it stays unchanged.)

- [ ] **Step 4: Pass `logFd` into `startLinkDaemon`**

Change the `startLinkDaemon({ ... })` call (currently lines 145-151) to include `logFd`:

```ts
    const handle = await startLinkDaemon({
      port,
      clusterBaseUrl,
      dataDir,
      session,
      monitor,
      logFd,
    });
```

- [ ] **Step 5: Close the fd in the `finally` backstop**

Change the `finally` block (currently lines 159-162) to also close the log file:

```ts
  } finally {
    // Backstop: console must never leak patched, regardless of exit path.
    restoreConsole?.();
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        // already closed
      }
    }
  }
```

- [ ] **Step 6: Verify it type-checks**

Run: `bun run check`
Expected: PASS — no type errors. `startLinkDaemon` accepts `logFd` (Task 2), `setLogPath` exists (Task 4), `formatLogLine` exists (Task 3).

- [ ] **Step 7: Commit**

```bash
git add apps/mesh/src/cli/commands/link.ts
git commit -m "feat(link): route deco link logs to <dataDir>/link.log"
```

---

## Task 6: Rebuild the preview table with truncating columns + `Logs:` hint

**Files:**
- Modify: `apps/mesh/src/cli/link-app.tsx` — add `COLS` constant, replace the table (`:88-112`), add the `Logs:` line (after `:118`)

This is JSX layout (no pure unit logic); verified by `check`/`lint` and the manual run in Task 7.

- [ ] **Step 1: Add the shared column-width constant**

In `apps/mesh/src/cli/link-app.tsx`, add this constant immediately after the `statusCell` function (after line 45, before `export function LinkApp`):

```tsx
// Shared by the header and every row so columns can never drift. Each fixed
// column gets a 1-cell right gutter (marginRight) so a fully-truncated cell
// still separates from the next. PREVIEW URL is last and takes the rest.
const COLS = {
  project: 18,
  status: 14,
  requests: 10,
  lastUsed: 11,
} as const;
```

- [ ] **Step 2: Replace the table rendering**

Replace the block that currently renders the table (the `{rows.length === 0 ? (...) : (...)}` expression, lines 88-112) with:

```tsx
      {rows.length === 0 ? (
        <Text dimColor>No previews running yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Box width={COLS.project} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                PROJECT
              </Text>
            </Box>
            <Box width={COLS.status} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                STATUS
              </Text>
            </Box>
            <Box width={COLS.requests} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                REQUESTS
              </Text>
            </Box>
            <Box width={COLS.lastUsed} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                LAST USED
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate-end">
                PREVIEW URL
              </Text>
            </Box>
          </Box>
          {rows.map((row) => {
            const s = statusCell(row);
            const idle =
              row.activeDispatchCount > 0
                ? "—"
                : formatIdle(now - row.lastChangeAt);
            return (
              <Box key={row.handle}>
                <Box width={COLS.project} flexShrink={0} marginRight={1}>
                  <Text wrap="truncate-end">{row.handle}</Text>
                </Box>
                <Box width={COLS.status} flexShrink={0} marginRight={1}>
                  <Text color={s.color} wrap="truncate-end">
                    {s.text}
                  </Text>
                </Box>
                <Box width={COLS.requests} flexShrink={0} marginRight={1}>
                  <Text wrap="truncate-end">
                    {String(row.activeDispatchCount)}
                  </Text>
                </Box>
                <Box width={COLS.lastUsed} flexShrink={0} marginRight={1}>
                  <Text wrap="truncate-end">{idle}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate-end">
                    {row.previewUrl ?? "—"}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
```

- [ ] **Step 3: Add the `Logs:` hint line**

Immediately after the `{state.daemonError ? (...) : null}` block (currently ends at line 118, before the closing `</Box>` of the root), add:

```tsx
      {state.logPath ? (
        <Box marginTop={1}>
          <Text dimColor>Logs: {state.logPath}</Text>
        </Box>
      ) : null}
```

- [ ] **Step 4: Verify type-check and lint**

Run: `bun run check && bun run lint`
Expected: PASS. (`state.logPath` exists from Task 4; `wrap="truncate-end"` is a valid Ink `Text` prop.)

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-app.tsx
git commit -m "fix(link): fixed-width truncating table columns + logs hint"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite for touched areas**

Run:
```bash
bun test packages/sandbox/server/daemon-spawn.test.ts apps/mesh/src/cli/format-log-line.test.ts apps/mesh/src/cli/link-store.test.ts
```
Expected: PASS (all tests green).

- [ ] **Step 2: Type-check, lint, format-check the whole repo**

Run:
```bash
bun run check && bun run lint && bun run fmt:check
```
Expected: PASS.

- [ ] **Step 3: Manual end-to-end smoke test**

Run `bunx` / local `decocms link` against a studio, open a preview whose handle is long (~29 chars), and confirm:

1. No `[daemon] … proxy GET …` lines paint over the TUI.
2. `<dataDir>/link.log` (default `~/deco/link.log`) exists and contains both
   parent (`[user-desktop] …`, `Local ingress listening…`, `Linked to…`) and
   child (`[daemon] …`) output.
3. The table columns stay aligned; the long handle truncates with `…` in the
   PROJECT column; the full handle is still visible in the PREVIEW URL column.
4. The TUI footer shows `Logs: <dataDir>/link.log`.
5. `decocms link --no-tui` still streams daemon logs to the terminal (no
   regression — `logFd` is undefined, so the child inherits the fds).

- [ ] **Step 4: Final commit (if fmt changed anything)**

```bash
git add -A
git commit -m "chore(link): formatting after TUI corruption fixes" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** Fix 1 (log file) → Tasks 1,2,3,4,5; Fix 2 (truncating table) → Task 6; `Logs:` discoverability → Tasks 4 (store) + 6 (view); testing → Tasks 1,3,4 (unit) + 7 (manual/e2e). The "files touched" table in the spec maps 1:1 to the tasks above.
- **Placeholders:** none — every code step shows full code.
- **Type consistency:** `outFd` (spawn factory option, Task 1) ↔ `logFd` (daemon/CLI option, Tasks 2/5) are deliberately distinct names at their respective layers; `resolveDaemonStdio`, `formatLogLine`, `setLogPath`, `logPath`, and `COLS` are used with identical signatures/shapes everywhere they appear.
- **Non-pure wiring** (Tasks 2, 5, 6) is verified via `bun run check`/`lint` + the Task 7 manual run, consistent with `TESTING.md` (no mocks for I/O-bound code).
