# Unified CLI TUI + `link` Task-Manager View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `decocms` CLI one shared banner, a consistent `--no-tui` contract across `serve`/`dev`/`link`, a live task-manager view for `link`, and remove vibe mode, the `L`/`K` toggles, the config view, and the terminal-height log windowing.

**Architecture:** A pure `banner-art.ts` module owns the ASCII art once (consumed by a plain printer and an Ink `<Banner>`). A `resolveTui` helper centralizes the TUI-vs-plain decision. The desktop link daemon gains additive `SandboxEvent`s that feed a `link-store` (same external-store pattern as the existing `cli-store`), rendered by a new `link-app.tsx`. `serve`/`dev`'s Ink shell is stripped down to banner + status + a plain growing request log with no key input.

**Tech Stack:** TypeScript, Bun (test runner + runtime), Ink + React 19 (no `useEffect`/`useMemo` — use `useSyncExternalStore`), Biome (`bun run fmt`), oxlint (`bun run lint`), `bun run check` (tsc).

**Spec:** `docs/superpowers/specs/2026-05-29-cli-tui-unification-design.md`

**Conventions for every task:** run `bun run fmt` before committing. Use Conventional Commit messages. End commit messages with the repo's `Co-Authored-By` trailer.

---

## File Structure

**New:**
- `apps/mesh/src/cli/banner-art.ts` — pure art data + plain ANSI renderer (`BANNER_LINES`, `BANNER_GRADIENT`, `bannerLines`, `printBanner`). No Ink import.
- `apps/mesh/src/cli/banner-art.test.ts` — unit tests for the pure renderer.
- `apps/mesh/src/cli/banner.tsx` — Ink `<Banner>` component (imports `banner-art`).
- `apps/mesh/src/cli/resolve-tui.ts` — `resolveTui()` helper.
- `apps/mesh/src/cli/resolve-tui.test.ts` — unit tests.
- `apps/mesh/src/cli/link-store.ts` — external store + pure reducer (`applySandboxEvent`) + `formatIdle` for the link view.
- `apps/mesh/src/cli/link-store.test.ts` — unit tests for reducer + `formatIdle`.
- `apps/mesh/src/cli/link-app.tsx` — Ink task-manager view (render-only).

**Modified:**
- `apps/mesh/src/cli.ts` — adopt `printBanner`/`resolveTui`, remove `--vibe`, wire `link` TUI.
- `apps/mesh/src/index.ts` — use `bannerLines()` instead of `ASCII_ART`.
- `apps/mesh/src/cli/header.tsx` — use `<Banner>`, drop vibe branch + all key hints.
- `apps/mesh/src/cli/app.tsx` — drop vibe/`L`/`K` handlers, `useInput`, `viewMode` branch, `HEADER_HEIGHT*`.
- `apps/mesh/src/cli/cli-store.ts` — drop `vibe`/`logFlow`/`viewMode`/`env` state + setters.
- `apps/mesh/src/cli/request-log.tsx` — full list, no windowing.
- `apps/mesh/src/cli/commands/serve.ts`, `commands/dev.ts` — remove `setEnv`.
- `apps/mesh/src/cli/commands/link.ts` — TUI wiring + console interception.
- `apps/mesh/src/link-daemon/index.ts` — `LinkDaemonMonitor` plumbing.
- `apps/mesh/src/link-daemon/user-desktop-provider.ts` — `SandboxEvent` emission.
- `apps/mesh/src/link-daemon/user-desktop-provider.test.ts` — event-emission tests.

**Deleted:**
- `apps/mesh/src/fmt.ts` (both exports become unused).
- `apps/mesh/src/cli/vibe/vibe-player.ts`, `apps/mesh/src/cli/vibe/playlist.json`.
- `apps/mesh/src/cli/capy-frames.ts`, `capy-animation.ts`, `matrix-rain.ts`.
- `apps/mesh/src/cli/use-terminal-size.ts`.
- `apps/mesh/src/cli/config-view.tsx`.

---

## Task 1: Shared banner art module (pure)

**Files:**
- Create: `apps/mesh/src/cli/banner-art.ts`
- Test: `apps/mesh/src/cli/banner-art.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/cli/banner-art.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { BANNER_GRADIENT, BANNER_LINES, bannerLines } from "./banner-art";

describe("banner-art", () => {
  it("has one gradient color per art line", () => {
    expect(BANNER_LINES.length).toBe(8);
    expect(BANNER_GRADIENT.length).toBe(BANNER_LINES.length);
  });

  it("renders the art with no version line when version is omitted", () => {
    const lines = bannerLines();
    expect(lines.length).toBe(BANNER_LINES.length);
    // Truecolor escape prefix on every art line.
    expect(lines.every((l) => l.startsWith("\x1b[38;2;"))).toBe(true);
  });

  it("appends a dimmed version line when a version is given", () => {
    const lines = bannerLines("1.2.3");
    expect(lines.length).toBe(BANNER_LINES.length + 1);
    expect(lines.at(-1)).toContain("1.2.3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/cli/banner-art.test.ts`
Expected: FAIL — `Cannot find module './banner-art'`.

- [ ] **Step 3: Write the module**

Create `apps/mesh/src/cli/banner-art.ts`:

```ts
/**
 * Single source of truth for the DECO ASCII banner.
 *
 * Pure (no Ink) so both the plain `--no-tui` path and the server startup
 * banner can import it without pulling React/Ink into their bundles. The
 * Ink `<Banner>` component (banner.tsx) consumes BANNER_LINES/BANNER_GRADIENT.
 */

export const BANNER_LINES = [
  " ██████████   ██████████   █████████     ███████   ",
  "░░███░░░░███ ░░███░░░░░█  ███░░░░░███  ███░░░░░███ ",
  " ░███   ░░███ ░███  █ ░  ███     ░░░  ███     ░░███",
  " ░███    ░███ ░██████   ░███         ░███      ░███",
  " ░███    ░███ ░███░░█   ░███         ░███      ░███",
  " ░███    ███  ░███ ░   █░░███     ███░░███     ███ ",
  " ██████████   ██████████ ░░█████████  ░░░███████░  ",
  "░░░░░░░░░░   ░░░░░░░░░░   ░░░░░░░░░     ░░░░░░░   ",
];

export const BANNER_GRADIENT = [
  "#00ff64",
  "#00ee5e",
  "#00dc56",
  "#00c84e",
  "#00b444",
  "#00a03c",
  "#008832",
  "#006e28",
];

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * The banner as an array of ANSI-colored strings. Pass `version` to append
 * a dimmed ` v<version>` line; omit it for the bare art.
 */
export function bannerLines(version?: string): string[] {
  const out = BANNER_LINES.map((line, i) => {
    const [r, g, b] = hexToRgb(BANNER_GRADIENT[i]!);
    return `\x1b[38;2;${r};${g};${b}m${line}\x1b[39m`;
  });
  if (version !== undefined) {
    out.push(`\x1b[2m  v${version}\x1b[22m`);
  }
  return out;
}

/** Print the banner to stdout, padded with blank lines (plain / --no-tui path). */
export function printBanner(version: string): void {
  console.log("");
  for (const line of bannerLines(version)) console.log(line);
  console.log("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/banner-art.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/banner-art.ts apps/mesh/src/cli/banner-art.test.ts
git commit -m "feat(cli): add shared banner-art module"
```

---

## Task 2: Ink `<Banner>` component

**Files:**
- Create: `apps/mesh/src/cli/banner.tsx`

- [ ] **Step 1: Write the component**

Create `apps/mesh/src/cli/banner.tsx`:

```tsx
import { Box, Text } from "ink";
import { BANNER_GRADIENT, BANNER_LINES } from "./banner-art";

/** Ink rendering of the shared DECO banner. */
export function Banner({ version }: { version: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {BANNER_LINES.map((line, i) => (
        <Text key={i} color={BANNER_GRADIENT[i]}>
          {line}
        </Text>
      ))}
      <Text dimColor> v{version}</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `bun run check`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/banner.tsx
git commit -m "feat(cli): add Ink Banner component"
```

---

## Task 3: Switch plain-banner consumers to `banner-art`, delete `fmt.ts`

**Files:**
- Modify: `apps/mesh/src/cli.ts` (two `--no-tui` blocks)
- Modify: `apps/mesh/src/index.ts:194-201`
- Delete: `apps/mesh/src/fmt.ts`

- [ ] **Step 1: Replace the `dev --no-tui` banner block in `cli.ts`**

In `apps/mesh/src/cli.ts`, find the dev no-tui block (currently around lines 272-279):

```ts
  if (noTui) {
    const { ASCII_ART, dim } = await import("./fmt");
    console.log("");
    for (const line of ASCII_ART) {
      console.log(line);
    }
    console.log(dim(`  v${await getVersion()}`));
    console.log("");
```

Replace the import + print lines with:

```ts
  if (noTui) {
    const { printBanner } = await import("./cli/banner-art");
    printBanner(await getVersion());
```

(Leave the rest of the block — the `startDevServer` call etc. — untouched.)

- [ ] **Step 2: Replace the `serve --no-tui` banner block in `cli.ts`**

Find the serve no-tui block (currently around lines 341-348):

```ts
  // Plain stdout mode — no Ink, just console.log (CI-friendly)
  const { ASCII_ART, dim } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }
  console.log(dim(`  v${await getVersion()}`));
  console.log("");
```

Replace with:

```ts
  // Plain stdout mode — no Ink, just console.log (CI-friendly)
  const { printBanner } = await import("./cli/banner-art");
  printBanner(await getVersion());
```

- [ ] **Step 3: Replace the `ASCII_ART` block in `index.ts`**

In `apps/mesh/src/index.ts`, replace lines 194-201:

```ts
// When running via CLI, the calling script handles its own banner/config output
if (!settings.isCli) {
  const { ASCII_ART } = await import("./fmt");
  console.log("");
  for (const line of ASCII_ART) {
    console.log(line);
  }
}
```

with:

```ts
// When running via CLI, the calling script handles its own banner/config output
if (!settings.isCli) {
  const { bannerLines } = await import("./cli/banner-art");
  console.log("");
  for (const line of bannerLines()) {
    console.log(line);
  }
}
```

- [ ] **Step 4: Delete `fmt.ts` and confirm no stragglers**

```bash
git rm apps/mesh/src/fmt.ts
```

Run: `grep -rn "from \"\\.\\./fmt\"\|from \"\\./fmt\"\|ASCII_ART" apps/mesh/src`
Expected: no matches.

- [ ] **Step 5: Type-check + lint**

Run: `bun run check && bun run lint`
Expected: PASS (knip reports no unused `fmt` exports because the file is gone).

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli.ts apps/mesh/src/index.ts
git commit -m "refactor(cli): use shared banner-art, drop fmt.ts"
```

---

## Task 4: `resolveTui` helper

**Files:**
- Create: `apps/mesh/src/cli/resolve-tui.ts`
- Test: `apps/mesh/src/cli/resolve-tui.test.ts`
- Modify: `apps/mesh/src/cli.ts` (dev + serve TUI decision)

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/cli/resolve-tui.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveTui } from "./resolve-tui";

describe("resolveTui", () => {
  it("disables the TUI when --no-tui is passed, even on a TTY", () => {
    expect(resolveTui({ noTui: true, isTty: true })).toBe(false);
  });

  it("disables the TUI on a non-TTY even without --no-tui", () => {
    expect(resolveTui({ noTui: false, isTty: false })).toBe(false);
  });

  it("enables the TUI on a TTY without --no-tui", () => {
    expect(resolveTui({ noTui: false, isTty: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/cli/resolve-tui.test.ts`
Expected: FAIL — `Cannot find module './resolve-tui'`.

- [ ] **Step 3: Write the module**

Create `apps/mesh/src/cli/resolve-tui.ts`:

```ts
// Not exported — callers pass an object literal; mirrors how cli-store keeps
// CliState internal, which keeps knip's unused-export check clean.
interface ResolveTuiInput {
  /** True when the user passed `--no-tui`. */
  noTui: boolean;
  /** `process.stdout.isTTY` (undefined is treated as non-TTY). */
  isTty: boolean | undefined;
}

/**
 * Whether to render the Ink TUI. Off when `--no-tui` is passed or stdout is
 * not a TTY (CI, pipes). Shared by `serve`, `dev`, and `link`.
 */
export function resolveTui(input: ResolveTuiInput): boolean {
  if (input.noTui) return false;
  return input.isTty === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/cli/resolve-tui.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Adopt it in `cli.ts` for dev + serve**

Add a static import near the top of `apps/mesh/src/cli.ts` (with the other imports, after the `parseArgs` import):

```ts
import { resolveTui } from "./cli/resolve-tui";
```

In the dev branch, replace:

```ts
  const noTui = values["no-tui"] === true || !process.stdout.isTTY;
```

with:

```ts
  const noTui = !resolveTui({
    noTui: values["no-tui"] === true,
    isTty: process.stdout.isTTY,
  });
```

In the serve (default) branch, replace the same line:

```ts
const noTui = values["no-tui"] === true || !process.stdout.isTTY;
```

with:

```ts
const noTui = !resolveTui({
  noTui: values["no-tui"] === true,
  isTty: process.stdout.isTTY,
});
```

- [ ] **Step 6: Type-check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/resolve-tui.ts apps/mesh/src/cli/resolve-tui.test.ts apps/mesh/src/cli.ts
git commit -m "feat(cli): centralize TUI-vs-plain decision in resolveTui"
```

---

## Task 5: Remove vibe mode entirely

**Files:**
- Modify: `apps/mesh/src/cli.ts`
- Modify: `apps/mesh/src/cli/header.tsx`
- Modify: `apps/mesh/src/cli/app.tsx`
- Modify: `apps/mesh/src/cli/cli-store.ts`
- Delete: `apps/mesh/src/cli/vibe/vibe-player.ts`, `apps/mesh/src/cli/vibe/playlist.json`, `apps/mesh/src/cli/capy-frames.ts`, `apps/mesh/src/cli/capy-animation.ts`, `apps/mesh/src/cli/matrix-rain.ts`

- [ ] **Step 1: Remove the `--vibe` flag and help text in `cli.ts`**

In the `parseArgs` options object, delete:

```ts
    vibe: {
      type: "boolean",
      default: false,
    },
```

In the `--help` text, delete the line:

```
  --vibe                Play synthwave soundtrack while running
```

- [ ] **Step 2: Remove the four `values.vibe` blocks in `cli.ts`**

Delete the dev no-tui vibe block:

```ts
    if (values.vibe === true) {
      const { startVibe } = await import("./cli/vibe/vibe-player");
      startVibe(decoHome);
    }
```

In the dev TUI branch, change the destructured import from:

```ts
    const { setDevMode, setVibe, setDataDir } = await import("./cli/cli-store");
```

to:

```ts
    const { setDevMode, setDataDir } = await import("./cli/cli-store");
```

and delete the dev TUI vibe block:

```ts
    if (values.vibe === true) {
      const { startVibe } = await import("./cli/vibe/vibe-player");
      setVibe(true);
      startVibe(decoHome);
    }
```

Delete the serve no-tui vibe block:

```ts
  if (values.vibe === true) {
    const { startVibe } = await import("./cli/vibe/vibe-player");
    startVibe(decoHome);
  }
```

Delete the serve TUI vibe block:

```ts
  if (values.vibe === true) {
    const { startVibe } = await import("./cli/vibe/vibe-player");
    const { setVibe } = await import("./cli/cli-store");
    setVibe(true);
    startVibe(decoHome);
  }
```

- [ ] **Step 3: Rewrite `header.tsx` to use `<Banner>` and drop the vibe branch**

Replace the entire contents of `apps/mesh/src/cli/header.tsx` with:

```tsx
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import pkg from "../../package.json" with { type: "json" };
import { Banner } from "./banner";

export interface ServiceStatus {
  name: string;
  status: "pending" | "ready";
  port: number;
}

interface HeaderProps {
  services: ServiceStatus[];
  migrationsStatus: "pending" | "done";
  home: string;
  serverUrl: string | null;
}

function StatusIndicator({ status }: { status: "pending" | "ready" | "done" }) {
  if (status === "pending") {
    return <Spinner label="" />;
  }
  return <Text color="green">{"✓"}</Text>;
}

export function Header({
  services,
  migrationsStatus,
  home,
  serverUrl,
}: HeaderProps) {
  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Banner version={pkg.version} />

      <Box marginBottom={1}>
        <Text dimColor>{"─".repeat(80)}</Text>
      </Box>

      <Box>
        <Text dimColor>Home: {home}</Text>
      </Box>

      <Box gap={2}>
        {services.map((svc) => (
          <Box key={svc.name} gap={1}>
            <Text>
              {svc.name} :{svc.port || "...."}
            </Text>
            <StatusIndicator status={svc.status} />
          </Box>
        ))}
        <Box gap={1}>
          <Text>Migrations</Text>
          <StatusIndicator status={migrationsStatus} />
        </Box>
      </Box>

      <Box>
        {serverUrl ? (
          <Text>
            Open in browser: <Text color="cyan">{serverUrl}</Text>
          </Text>
        ) : (
          <Text dimColor>Starting...</Text>
        )}
      </Box>
    </Box>
  );
}
```

(Note: this removes the `V`/`N` vibe hints. The `K`/`L` hints are also gone — they are removed in Task 6, but since the whole hint `Box` is dropped here, no further header edits for hints are needed in Task 6.)

- [ ] **Step 4: Remove vibe handlers + props in `app.tsx`**

In `apps/mesh/src/cli/app.tsx`:

Remove the vibe imports — change:

```tsx
import {
  getCliState,
  subscribeCliState,
  toggleLogFlow,
  toggleViewMode,
  toggleVibeState,
} from "./cli-store";
import { skipTrack, toggleVibe } from "./vibe/vibe-player";
```

to:

```tsx
import {
  getCliState,
  subscribeCliState,
  toggleLogFlow,
  toggleViewMode,
} from "./cli-store";
```

Remove the `V` and `N` handlers from the `useInput` callback (delete these blocks):

```tsx
    if ((_input === "v" || _input === "V") && state.dataDir) {
      toggleVibe(state.dataDir);
      toggleVibeState();
    }
    if ((_input === "n" || _input === "N") && state.vibe) {
      skipTrack();
    }
```

Remove the `vibe` prop passed to `<Header>` (delete the `vibe={state.vibe}` line) and simplify the `RequestLog` height (the `HEADER_HEIGHT_VIBE` ternary). Change:

```tsx
        <RequestLog
          logs={state.logs}
          headerHeight={state.vibe ? HEADER_HEIGHT_VIBE : HEADER_HEIGHT}
        />
```

to:

```tsx
        <RequestLog logs={state.logs} headerHeight={HEADER_HEIGHT} />
```

and delete the now-unused constant:

```tsx
const HEADER_HEIGHT_VIBE = 19;
```

- [ ] **Step 5: Remove vibe state from `cli-store.ts`**

In `apps/mesh/src/cli/cli-store.ts`:
- Remove `vibe: boolean;` from the `CliState` interface.
- Remove `vibe: false,` from the initial `state`.
- Delete the `setVibe` and `toggleVibeState` functions:

```ts
export function setVibe(value: boolean) {
  state = { ...state, vibe: value };
  emit();
}

export function toggleVibeState() {
  state = { ...state, vibe: !state.vibe };
  emit();
}
```

- [ ] **Step 6: Delete the vibe + animation source files**

```bash
git rm apps/mesh/src/cli/vibe/vibe-player.ts apps/mesh/src/cli/vibe/playlist.json
git rm apps/mesh/src/cli/capy-frames.ts apps/mesh/src/cli/capy-animation.ts apps/mesh/src/cli/matrix-rain.ts
```

- [ ] **Step 7: Type-check, lint, test**

Run: `bun run check && bun run lint && bun test apps/mesh/src/cli/`
Expected: PASS. (`grep -rn "vibe\|capy\|matrix-rain" apps/mesh/src/cli apps/mesh/src/cli.ts` should return no matches.)

- [ ] **Step 8: Commit**

```bash
bun run fmt
git add -A apps/mesh/src/cli apps/mesh/src/cli.ts
git commit -m "feat(cli): remove vibe mode and use shared Banner in header"
```

---

## Task 6: Remove `L`/`K` toggles, config view, and auto-scroll windowing

**Files:**
- Modify: `apps/mesh/src/cli/app.tsx`
- Modify: `apps/mesh/src/cli/cli-store.ts`
- Modify: `apps/mesh/src/cli/request-log.tsx`
- Modify: `apps/mesh/src/cli/commands/serve.ts`, `apps/mesh/src/cli/commands/dev.ts`
- Delete: `apps/mesh/src/cli/config-view.tsx`, `apps/mesh/src/cli/use-terminal-size.ts`

- [ ] **Step 1: Rewrite `app.tsx` to its final form**

Replace the entire contents of `apps/mesh/src/cli/app.tsx` with:

```tsx
import { Box } from "ink";
import { useSyncExternalStore } from "react";
import { Header } from "./header";
import { RequestLog } from "./request-log";
import { getCliState, subscribeCliState } from "./cli-store";

export function App({ home }: { home: string }) {
  const state = useSyncExternalStore(subscribeCliState, getCliState);

  return (
    <Box flexDirection="column">
      <Header
        services={state.services}
        migrationsStatus={state.migrationsStatus}
        home={home}
        serverUrl={state.serverUrl}
      />
      <RequestLog logs={state.logs} />
    </Box>
  );
}
```

(This drops `useInput`, the `K`/`L` handlers, the `ConfigView`/`viewMode` branch, the `Text` "Loading configuration" fallback, and both `HEADER_HEIGHT*` constants.)

- [ ] **Step 2: Rewrite `request-log.tsx` to map the full list**

Replace the entire contents of `apps/mesh/src/cli/request-log.tsx` with:

```tsx
import { Box, Text } from "ink";
import type { LogEntry } from "./log-emitter";

function statusColor(status: number): string {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

export function RequestLog({ logs }: { logs: LogEntry[] }) {
  return (
    <Box flexDirection="column">
      {logs.map((entry, i) => {
        if (entry.rawLine) {
          return (
            <Text key={i} dimColor>
              {entry.rawLine}
            </Text>
          );
        }

        const durationStr =
          entry.duration < 1000
            ? `${entry.duration}ms`
            : `${(entry.duration / 1000).toFixed(1)}s`;

        return (
          <Text key={i}>
            <Text dimColor>
              {entry.method.padEnd(6)} {entry.path.padEnd(30)}{" "}
            </Text>
            <Text color={statusColor(entry.status)}>{entry.status}</Text>
            <Text dimColor> {durationStr.padStart(8)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
```

(This removes `useTerminalSize`, `useSyncExternalStore`, the `logFlow` read, the `headerHeight` prop, and the `slice(-visibleCount)` windowing.)

- [ ] **Step 3: Remove `logFlow`, `viewMode`, `env` state from `cli-store.ts`**

In `apps/mesh/src/cli/cli-store.ts`:
- Delete the `import type { Settings } from "../settings";` line.
- In `CliState`, delete `env: Settings | null;`, `viewMode: "requests" | "config";`, and `logFlow: boolean;`.
- In the initial `state`, delete `env: null,`, `viewMode: "requests",`, and `logFlow: false,`.
- Delete the `setEnv`, `toggleViewMode`, and `toggleLogFlow` functions:

```ts
export function setEnv(env: Settings) {
  state = { ...state, env };
  emit();
}
```

```ts
export function toggleViewMode() {
  state = {
    ...state,
    viewMode: state.viewMode === "requests" ? "config" : "requests",
  };
  emit();
}
```

```ts
export function toggleLogFlow() {
  state = {
    ...state,
    logFlow: !state.logFlow,
  };
  emit();
}
```

- [ ] **Step 4: Remove `setEnv` from `serve.ts` and `dev.ts`**

In `apps/mesh/src/cli/commands/serve.ts`: remove `setEnv,` from the `cli-store` import block (lines ~10-16) and delete the `setEnv(settings);` call (line ~93).

In `apps/mesh/src/cli/commands/dev.ts`: remove `setEnv,` from the `cli-store` import block (line ~14) and delete the `setEnv(settings);` call (line ~116).

- [ ] **Step 5: Delete the config view and terminal-size hook**

```bash
git rm apps/mesh/src/cli/config-view.tsx apps/mesh/src/cli/use-terminal-size.ts
```

- [ ] **Step 6: Type-check, lint, test**

Run: `bun run check && bun run lint && bun test apps/mesh/src/cli/`
Expected: PASS. (`grep -rn "logFlow\|viewMode\|ConfigView\|useTerminalSize\|setEnv\|toggleViewMode\|toggleLogFlow" apps/mesh/src/cli` should return no matches.)

- [ ] **Step 7: Commit**

```bash
bun run fmt
git add -A apps/mesh/src/cli
git commit -m "feat(cli): drop L/K toggles, config view, and log windowing"
```

---

## Task 7: Emit `SandboxEvent`s from the desktop provider

**Files:**
- Modify: `apps/mesh/src/link-daemon/user-desktop-provider.ts`
- Test: `apps/mesh/src/link-daemon/user-desktop-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/mesh/src/link-daemon/user-desktop-provider.test.ts` (inside the existing `describe("desktop sandbox provider", ...)` block). Also add this import at the top of the file, alongside the existing `createDesktopSandboxProvider` import:

```ts
import {
  createDesktopSandboxProvider,
  type SandboxEvent,
} from "./user-desktop-provider";
```

New tests:

```ts
it("emits spawning then ready events via onEvent", async () => {
  const dataDir = tmpDataDir();
  try {
    const events: SandboxEvent[] = [];
    let portCounter = 30000;
    const provider = createDesktopSandboxProvider({
      dataDir,
      spawnDaemon: () => fakeDaemonSpawner(),
      postConfig: async () => {},
      waitForHealth: async () => {},
      pickPort: () => portCounter++,
      onEvent: (e) => events.push(e),
    });
    await provider.ensureSandbox({ handle: "abc", repo: undefined });
    const phases = events.filter((e) => e.handle === "abc").map((e) => e.phase);
    expect(phases).toContain("spawning");
    expect(phases).toContain("ready");
    expect(phases.indexOf("spawning")).toBeLessThan(phases.indexOf("ready"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("emits a failed event when bring-up throws", async () => {
  const dataDir = tmpDataDir();
  try {
    const events: SandboxEvent[] = [];
    let portCounter = 30000;
    const provider = createDesktopSandboxProvider({
      dataDir,
      spawnDaemon: () => fakeDaemonSpawner(),
      postConfig: async () => {},
      waitForHealth: async () => {
        throw new Error("boom");
      },
      pickPort: () => portCounter++,
      onEvent: (e) => events.push(e),
    });
    await expect(
      provider.ensureSandbox({ handle: "xyz", repo: undefined }),
    ).rejects.toThrow();
    const failed = events.find((e) => e.handle === "xyz" && e.phase === "failed");
    expect(failed?.error).toContain("boom");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/link-daemon/user-desktop-provider.test.ts`
Expected: FAIL — `SandboxEvent` is not exported / `onEvent` is not a known dep.

- [ ] **Step 3: Add the event types + `onEvent` dep**

In `apps/mesh/src/link-daemon/user-desktop-provider.ts`, add these exported types near the other `export interface` declarations (e.g. just below `SpawnResult`):

```ts
// Not exported — only referenced via SandboxEvent.phase below.
type SandboxPhase =
  | "spawning"
  | "ready"
  | "failed"
  | "evicted"
  | "deleted";

/**
 * Observability event emitted on every sandbox lifecycle transition.
 * Purely additive — consumers (the link TUI store) subscribe via the
 * provider's `onEvent` dep. Never alters control flow.
 */
export interface SandboxEvent {
  handle: string;
  phase: SandboxPhase;
  port?: number;
  previewUrl?: string;
  /** Set on `failed`. */
  error?: string;
  activeDispatchCount?: number;
}
```

Add to the `DesktopSandboxProviderDeps` interface:

```ts
  /** Optional observability hook for lifecycle transitions (link TUI). */
  onEvent?: (event: SandboxEvent) => void;
```

- [ ] **Step 4: Emit events at each transition**

In `createDesktopSandboxProvider`, just after the `resolvePreviewUrl` const is defined, add:

```ts
  const emit = (event: SandboxEvent): void => deps.onEvent?.(event);
```

In `evictIfNeeded`, after `sandboxes.delete(victim.handle);` add:

```ts
    emit({ handle: victim.handle, phase: "evicted" });
```

In `evictDead`, inside the `if (sandboxes.get(state.handle) === state)` block, after `sandboxes.delete(state.handle);` add:

```ts
      emit({ handle: state.handle, phase: "evicted" });
```

In `buildEntry`, at the very top (before `evictIfNeeded()`), add:

```ts
    emit({ handle: input.handle, phase: "spawning" });
```

In `buildEntry`'s `catch (err)` block, before `throw err;`, add:

```ts
      emit({
        handle: input.handle,
        phase: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
```

In `buildEntry`, after `sandboxes.set(input.handle, state);`, add:

```ts
    emit({
      handle: input.handle,
      phase: "ready",
      port,
      previewUrl,
      activeDispatchCount: 0,
    });
```

In `buildEntry`'s watchdog (`spawned.exited.then(...)`), inside the `if (current === state)` block, after `sandboxes.delete(input.handle);` add:

```ts
          emit({ handle: input.handle, phase: "evicted" });
```

In the returned object's `acquireDispatch`, after `s.activeDispatchCount += 1;` add:

```ts
      emit({
        handle,
        phase: "ready",
        activeDispatchCount: s.activeDispatchCount,
      });
```

and inside the returned release closure, after `cur.activeDispatchCount = Math.max(0, cur.activeDispatchCount - 1);` add:

```ts
          emit({
            handle,
            phase: "ready",
            activeDispatchCount: cur.activeDispatchCount,
          });
```

In `deleteSandbox`, after `sandboxes.delete(handle);` add:

```ts
      emit({ handle, phase: "deleted" });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/mesh/src/link-daemon/user-desktop-provider.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/user-desktop-provider.ts apps/mesh/src/link-daemon/user-desktop-provider.test.ts
git commit -m "feat(link-daemon): emit sandbox lifecycle events"
```

---

## Task 8: `link-store` (reducer + state + helpers)

**Files:**
- Create: `apps/mesh/src/cli/link-store.ts`
- Test: `apps/mesh/src/cli/link-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/mesh/src/cli/link-store.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { applySandboxEvent, formatIdle, type SandboxRow } from "./link-store";

function empty(): Map<string, SandboxRow> {
  return new Map();
}

describe("applySandboxEvent", () => {
  it("adds a spawning row then promotes it to ready with port", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "spawning" }, 1000);
    expect(m.get("a")?.status).toBe("spawning");

    m = applySandboxEvent(
      m,
      { handle: "a", phase: "ready", port: 51234, previewUrl: "http://a.localhost:5174" },
      2000,
    );
    expect(m.get("a")?.status).toBe("ready");
    expect(m.get("a")?.port).toBe(51234);
    expect(m.get("a")?.previewUrl).toBe("http://a.localhost:5174");
  });

  it("records the error on failure and retains the row", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "spawning" }, 1000);
    m = applySandboxEvent(m, { handle: "a", phase: "failed", error: "clone failed" }, 2000);
    expect(m.get("a")?.status).toBe("failed");
    expect(m.get("a")?.error).toBe("clone failed");
  });

  it("clears the error when a failed handle starts spawning again", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "failed", error: "x" }, 1000);
    m = applySandboxEvent(m, { handle: "a", phase: "spawning" }, 2000);
    expect(m.get("a")?.status).toBe("spawning");
    expect(m.get("a")?.error).toBeNull();
  });

  it("preserves the port across a dispatch-count update", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "ready", port: 7 }, 1000);
    m = applySandboxEvent(m, { handle: "a", phase: "ready", activeDispatchCount: 2 }, 2000);
    expect(m.get("a")?.port).toBe(7);
    expect(m.get("a")?.activeDispatchCount).toBe(2);
  });

  it("removes the row on evicted and deleted", () => {
    let m = applySandboxEvent(empty(), { handle: "a", phase: "ready", port: 7 }, 1000);
    m = applySandboxEvent(m, { handle: "a", phase: "evicted" }, 2000);
    expect(m.has("a")).toBe(false);

    let n = applySandboxEvent(empty(), { handle: "b", phase: "ready", port: 8 }, 1000);
    n = applySandboxEvent(n, { handle: "b", phase: "deleted" }, 2000);
    expect(n.has("b")).toBe(false);
  });
});

describe("formatIdle", () => {
  it("formats sub-minute, minute, and hour ranges", () => {
    expect(formatIdle(500)).toBe("0s");
    expect(formatIdle(5_000)).toBe("5s");
    expect(formatIdle(65_000)).toBe("1m");
    expect(formatIdle(3_700_000)).toBe("1h");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/cli/link-store.test.ts`
Expected: FAIL — `Cannot find module './link-store'`.

- [ ] **Step 3: Write the store**

Create `apps/mesh/src/cli/link-store.ts`:

```ts
/**
 * External store for the `deco link` task-manager TUI. The daemon pushes
 * cluster/ingress status and SandboxEvents here; the Ink view subscribes via
 * useSyncExternalStore (no useEffect). Mirrors the cli-store pattern.
 */
import type { SandboxEvent } from "../link-daemon/user-desktop-provider";

// Not exported — internal to this store (mirrors cli-store's CliState).
type ClusterStatus = "connecting" | "linked" | "closed";

export interface SandboxRow {
  handle: string;
  port: number | null;
  previewUrl: string | null;
  status: "spawning" | "ready" | "failed";
  error: string | null;
  activeDispatchCount: number;
  /** Wall-clock ms of the last event for this handle; drives the IDLE column. */
  lastChangeAt: number;
}

// Not exported — mirrors cli-store's CliState.
interface LinkState {
  cluster: ClusterStatus;
  ingressUrl: string | null;
  ingressPort: number | null;
  machine: string | null;
  cap: number;
  sandboxes: Map<string, SandboxRow>;
  daemonError: string | null;
}

const DEFAULT_CAP = 20;

/**
 * Pure reducer: fold a SandboxEvent into the sandbox map. `evicted`/`deleted`
 * drop the row; `failed` retains it with its error until the next `spawning`.
 */
export function applySandboxEvent(
  sandboxes: Map<string, SandboxRow>,
  e: SandboxEvent,
  now: number,
): Map<string, SandboxRow> {
  const next = new Map(sandboxes);
  if (e.phase === "evicted" || e.phase === "deleted") {
    next.delete(e.handle);
    return next;
  }
  const prev = next.get(e.handle);
  next.set(e.handle, {
    handle: e.handle,
    port: e.port ?? prev?.port ?? null,
    previewUrl: e.previewUrl ?? prev?.previewUrl ?? null,
    status: e.phase, // "spawning" | "ready" | "failed"
    error: e.phase === "failed" ? (e.error ?? "failed") : null,
    activeDispatchCount: e.activeDispatchCount ?? prev?.activeDispatchCount ?? 0,
    lastChangeAt: now,
  });
  return next;
}

/** Relative idle duration, coarse (`0s`/`5s`/`1m`/`1h`). */
export function formatIdle(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

let state: LinkState = {
  cluster: "connecting",
  ingressUrl: null,
  ingressPort: null,
  machine: null,
  cap: DEFAULT_CAP,
  sandboxes: new Map(),
  daemonError: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function getLinkState(): LinkState {
  return state;
}

export function subscribeLinkState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCluster(status: ClusterStatus) {
  state = { ...state, cluster: status };
  emit();
}

export function setIngress(port: number, url: string) {
  state = { ...state, ingressPort: port, ingressUrl: url };
  emit();
}

export function setMachine(label: string) {
  state = { ...state, machine: label };
  emit();
}

export function setDaemonError(message: string) {
  state = { ...state, daemonError: message };
  emit();
}

export function pushSandboxEvent(event: SandboxEvent) {
  state = {
    ...state,
    sandboxes: applySandboxEvent(state.sandboxes, event, Date.now()),
  };
  emit();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/cli/link-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-store.ts apps/mesh/src/cli/link-store.test.ts
git commit -m "feat(cli): add link-store for the link task-manager view"
```

---

## Task 9: `link-app` Ink view

**Files:**
- Create: `apps/mesh/src/cli/link-app.tsx`

- [ ] **Step 1: Write the view**

Create `apps/mesh/src/cli/link-app.tsx`:

```tsx
import { Box, Text } from "ink";
import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { Banner } from "./banner";
import {
  formatIdle,
  getLinkState,
  type SandboxRow,
  subscribeLinkState,
} from "./link-store";

// 1 Hz clock so relative IDLE times re-render. This is display-only; it never
// polls the provider (structural changes arrive via link-store events).
let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const fn of clockListeners) fn();
    }, 1000);
    clockTimer.unref?.();
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClock(): number {
  return clockNow;
}

function statusCell(row: SandboxRow): { color: string; text: string } {
  if (row.status === "ready") return { color: "green", text: "● ready" };
  if (row.status === "spawning") return { color: "yellow", text: "◌ spawning" };
  return { color: "red", text: `✗ failed: ${row.error ?? ""}` };
}

export function LinkApp() {
  const state = useSyncExternalStore(subscribeLinkState, getLinkState);
  const now = useSyncExternalStore(subscribeClock, getClock);
  const rows = [...state.sandboxes.values()].sort((a, b) =>
    a.handle.localeCompare(b.handle),
  );

  return (
    <Box flexDirection="column">
      <Banner version={pkg.version} />

      <Box marginBottom={1}>
        <Text dimColor>{"─".repeat(80)}</Text>
      </Box>

      <Box>
        <Text>Cluster   </Text>
        {state.cluster === "linked" ? (
          <Text color="green">✓ linked</Text>
        ) : state.cluster === "connecting" ? (
          <Text color="yellow">◌ connecting</Text>
        ) : (
          <Text color="red">✗ disconnected</Text>
        )}
      </Box>
      <Box>
        <Text>Ingress   </Text>
        {state.ingressUrl ? (
          <Text color="green">✓ {state.ingressUrl}</Text>
        ) : (
          <Text dimColor>starting…</Text>
        )}
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          {`Machine   ${state.machine ?? "this machine"} · ${rows.length} / ${state.cap} sandboxes`}
        </Text>
      </Box>

      {rows.length === 0 ? (
        <Text dimColor>No sandboxes yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            {`${"HANDLE".padEnd(16)}${"PORT".padEnd(8)}${"STATUS".padEnd(22)}${"ACTIVE".padEnd(8)}${"IDLE".padEnd(8)}PREVIEW`}
          </Text>
          {rows.map((row) => {
            const s = statusCell(row);
            const idle =
              row.activeDispatchCount > 0
                ? "—"
                : formatIdle(now - row.lastChangeAt);
            return (
              <Box key={row.handle}>
                <Text>{row.handle.padEnd(16)}</Text>
                <Text>{String(row.port ?? "—").padEnd(8)}</Text>
                <Text color={s.color}>{s.text.padEnd(22)}</Text>
                <Text>{String(row.activeDispatchCount).padEnd(8)}</Text>
                <Text>{idle.padEnd(8)}</Text>
                <Text dimColor>{row.previewUrl ?? "—"}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {state.daemonError ? (
        <Box marginTop={1}>
          <Text color="red">⚠ {state.daemonError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
bun run fmt
git add apps/mesh/src/cli/link-app.tsx
git commit -m "feat(cli): add link task-manager Ink view"
```

---

## Task 10: Wire the `link` command to the TUI

**Files:**
- Modify: `apps/mesh/src/link-daemon/index.ts`
- Modify: `apps/mesh/src/cli/commands/link.ts`
- Modify: `apps/mesh/src/cli.ts`

- [ ] **Step 1: Add `LinkDaemonMonitor` plumbing to the daemon**

In `apps/mesh/src/link-daemon/index.ts`:

Add the import for the event type — change:

```ts
import {
  createDesktopSandboxProvider,
  type SpawnResult,
} from "./user-desktop-provider";
```

to:

```ts
import {
  createDesktopSandboxProvider,
  type SandboxEvent,
  type SpawnResult,
} from "./user-desktop-provider";
```

Add the monitor interface above `StartLinkDaemonOptions`:

```ts
/**
 * Optional observability hooks for the `deco link` TUI. All no-ops when the
 * daemon runs with `--no-tui` (the monitor is simply omitted).
 */
export interface LinkDaemonMonitor {
  onEvent?: (event: SandboxEvent) => void;
  onIngress?: (port: number) => void;
  onCluster?: (status: "connecting" | "linked" | "closed") => void;
  onMachine?: (label: string) => void;
}
```

Add to `StartLinkDaemonOptions`:

```ts
  /** Optional TUI hooks. Omitted in --no-tui mode. */
  monitor?: LinkDaemonMonitor;
```

In `startLinkDaemon`, pass `onEvent` into the provider — in the `createDesktopSandboxProvider({ ... })` call, add after `maxSandboxes: 20,`:

```ts
    onEvent: opts.monitor?.onEvent,
```

After `const hostname = osHostname() || undefined;`, add:

```ts
  opts.monitor?.onMachine?.(hostname ?? "this machine");
```

After `ingressPort = ingress.port;` (and the existing `console.log` for the ingress), add:

```ts
  opts.monitor?.onIngress?.(ingress.port);
```

In the `connectToCluster({ ... })` call, change the `onConnected` handler from:

```ts
    onConnected: () => console.log(`Linked to ${opts.clusterBaseUrl}`),
```

to:

```ts
    onConnected: () => {
      opts.monitor?.onCluster?.("linked");
      console.log(`Linked to ${opts.clusterBaseUrl}`);
    },
```

In the `void cluster.closed.then(...)` block, add `opts.monitor?.onCluster?.("closed");` as the first statement inside the callback:

```ts
  void cluster.closed.then(() => {
    opts.monitor?.onCluster?.("closed");
    if (!shuttingDown) {
      console.error("Cluster connection closed permanently; exiting.");
      void shutdown();
    }
  });
```

- [ ] **Step 2: Add TUI support to `runLinkCommand`**

Replace the entire contents of `apps/mesh/src/cli/commands/link.ts` with:

```ts
/**
 * `deco link` — start the desktop-side link daemon.
 *
 * Opens a WebSocket to `<MESH_CLUSTER_URL>/api/links/connect` and runs a
 * local ingress on `--port` for `<handle>.localhost` sandbox previews.
 *
 * Auth: calls `ensureSession` first (with normal console output so the OAuth
 * login flow is visible). With a TTY (and no `--no-tui`), renders the Ink
 * task-manager view; otherwise streams plain `console.log` output.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../lib/ensure-session";
import { startLinkDaemon, type LinkDaemonMonitor } from "../../link-daemon";

export interface LinkCommandOptions {
  port?: number;
  clusterBaseUrl?: string;
  dataDir?: string;
  /** Render the Ink task-manager view. False → plain console.log output. */
  tui?: boolean;
  /** Version string for the banner (plain mode). */
  version?: string;
}

/**
 * Swallow daemon stdout so it can't corrupt the Ink render; route errors to
 * the TUI footer via `onError`. `--no-tui` is the escape hatch for full logs.
 */
function interceptLinkConsole(onError: (msg: string) => void): () => void {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args: unknown[]) => {
    onError(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}

export async function runLinkCommand(
  opts: LinkCommandOptions = {},
): Promise<number> {
  const port = opts.port ?? 5174;
  const dataDir =
    opts.dataDir ??
    process.env.DATA_DIR ??
    process.env.DECOCMS_HOME ??
    join(homedir(), "deco");
  const clusterBaseUrl =
    opts.clusterBaseUrl ??
    process.env.MESH_CLUSTER_URL ??
    "https://studio.decocms.com";

  let restoreConsole: (() => void) | undefined;
  try {
    // Login flow (may open a browser / prompt) runs with normal console.
    const session = await ensureSession({ dataDir, intent: "Link" });

    let monitor: LinkDaemonMonitor | undefined;

    if (opts.tui) {
      const { render } = await import("ink");
      const { createElement } = await import("react");
      const { LinkApp } = await import("../link-app");
      const {
        pushSandboxEvent,
        setCluster,
        setDaemonError,
        setIngress,
        setMachine,
      } = await import("../link-store");

      setCluster("connecting");
      monitor = {
        onEvent: (e) => pushSandboxEvent(e),
        onIngress: (p) => setIngress(p, `http://127.0.0.1:${p}`),
        onCluster: (s) => setCluster(s),
        onMachine: (label) => setMachine(label),
      };
      restoreConsole = interceptLinkConsole(setDaemonError);
      render(createElement(LinkApp), { patchConsole: false });
    } else {
      const { printBanner } = await import("../banner-art");
      printBanner(opts.version ?? "0.0.0");
    }

    const handle = await startLinkDaemon({
      port,
      clusterBaseUrl,
      dataDir,
      session,
      monitor,
    });
    const code = await handle.stopped;
    restoreConsole?.();
    return code;
  } catch (err) {
    restoreConsole?.();
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
```

- [ ] **Step 3: Pass `tui`/`version` from `cli.ts`**

In `apps/mesh/src/cli.ts`, in the `if (command === "link")` branch, replace:

```ts
  const code = await runLinkCommand({
    port: portExplicit ? Number(values.port) : undefined,
  });
  process.exit(code);
```

with:

```ts
  const tui = resolveTui({
    noTui: values["no-tui"] === true,
    isTty: process.stdout.isTTY,
  });
  const code = await runLinkCommand({
    port: portExplicit ? Number(values.port) : undefined,
    tui,
    version: await getVersion(),
  });
  process.exit(code);
```

- [ ] **Step 4: Type-check, lint, full test**

Run: `bun run check && bun run lint && bun test apps/mesh/src/cli/ apps/mesh/src/link-daemon/`
Expected: PASS.

- [ ] **Step 5: Manual smoke test (optional but recommended)**

Plain path — confirm the banner prints and the daemon starts (it will attempt login/connection; Ctrl-C to exit):

Run: `DATA_DIR=/tmp/deco-link-smoke bun apps/mesh/src/cli.ts link --no-tui`
Expected: the DECO banner prints, then normal `console.log` daemon output; no crash on startup.

TUI path — in a real terminal, run the same command without `--no-tui` and confirm the banner + `Cluster`/`Ingress`/`Machine` status block render (no raw `[user-desktop]` log spam).

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/index.ts apps/mesh/src/cli/commands/link.ts apps/mesh/src/cli.ts
git commit -m "feat(link): render task-manager TUI, honor --no-tui"
```

---

## Final verification

- [ ] **Step 1: Full check + lint + test**

Run: `bun run check && bun run lint && bun test`
Expected: PASS.

- [ ] **Step 2: Confirm no dangling references**

Run: `grep -rn "vibe\|capy\|matrix-rain\|ASCII_ART\|useTerminalSize\|ConfigView\|toggleLogFlow\|toggleViewMode\|setVibe" apps/mesh/src`
Expected: no matches (other than possibly unrelated UI `vibe` references in `apps/mesh/src/web/` — those are the React admin UI's agent-creation feature, NOT the CLI, and are out of scope).

- [ ] **Step 3: Confirm formatting**

Run: `bun run fmt:check`
Expected: PASS.
