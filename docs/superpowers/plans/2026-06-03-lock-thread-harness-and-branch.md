# Lock thread harness, sandbox, and branch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once a thread has sent its first message, the harness, sandbox provider kind, and branch it runs on are immutable for the life of the thread; the UI advertises that lock; the server drops any client-provided overrides.

**Architecture:** Source of truth is the `threads` row (`harness_id`, `sandbox_provider_kind`, `branch` columns are already populated on first message). The client read path hydrates the chat input pickers from those columns when `harness_id IS NOT NULL`. The client write path stops sending those three fields for locked threads. The server defensively overrides them from the thread row before model resolution, so a stale client cannot bypass the lock. Model / tier / mode / credential remain freely user-controlled per send.

**Tech Stack:** Bun, TypeScript, Hono (server), React 19 + Vite (client), Kysely + PostgreSQL, Playwright (E2E), Biome (formatting), oxlint (linting).

**Spec:** `docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md`

---

## File Structure

**New files:**
- `apps/mesh/src/web/components/chat/resolve-submit-settings.ts` — Pure helper that decides whether to ship `harnessId` / `sandboxProviderKind` / `branch` in submit RequestOptions based on the thread's lock state. No React, no I/O.
- `apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts` — Co-located unit tests for the helper (pure logic, no mocks).
- `apps/mesh/e2e/tests/chat-locked-thread.spec.ts` — End-to-end Playwright test.

**Modified files:**
- `apps/mesh/src/web/components/chat/pills/agent-options.ts` — Add inverse helper `agentOptionFor(harness, sandbox)` so the read path can map `(thread.harness_id, thread.sandbox_provider_kind)` back to the `AgentOption` enum the rest of the UI uses.
- `apps/mesh/src/web/components/chat/chat-context.tsx` — Replace the proxy `isBranchLocked` predicate with `isThreadLocked` (keyed on `activeTask?.harness_id != null`); expose `lockedHarness`, `lockedSandbox`, `lockedBranch` on the task context; make `effectiveAgentOption` lock-aware; call `resolveSubmitSettings()` instead of inlining the three fields in `sendMessageInternal`.
- `apps/mesh/src/web/components/chat/input.tsx` — Switch the mode-picker `locked` prop from `isBranchLocked` to `isThreadLocked`; render a locked chip for the branch picker when `isThreadLocked` is true.
- `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx` — Forward the renamed prop.
- `apps/mesh/src/web/components/chat/pills/mode-picker.tsx` — Rename the prop / update the tooltip copy so it reflects the broader "thread runtime is pinned" semantic, not "branch is set."
- `apps/mesh/src/api/routes/decopilot/routes.ts` — Add the server-side lock guard in `validate()` before `resolvePerRequestModels`.

---

## Conventions for every task in this plan

- **Run formatting + linting + types before committing:** `bun run fmt && bun run lint && bun run check`. If any fails, fix before committing — the lefthook pre-commit hook will block otherwise.
- **No useEffect, no useMemo/useCallback/memo.** React 19 + the compiler handle memoization. `plugins/ban-use-effect.ts` and `plugins/ban-memoization.ts` will block the build.
- **File naming for new files in `packages/`:** kebab-case (enforced). The new client files are inside `apps/mesh`, where kebab-case is also the project convention.
- **Commit style:** Conventional Commits. Examples: `feat(chat): lock thread harness + sandbox at first message`, `fix(decopilot): drop client harness override on locked threads`, `test(chat): cover resolve-submit-settings lock cases`.

---

## Task 1: Pure helper `resolveSubmitSettings` + unit tests (TDD)

**Files:**
- Create: `apps/mesh/src/web/components/chat/resolve-submit-settings.ts`
- Create: `apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts`

**Why:** Encapsulate the lock decision (client-side) in a pure function so it can be unit-tested without React or DB. This is the only meaningful logic in the client write-path change; the rest is plumbing.

- [ ] **Step 1.1: Write the failing test file**

Create `apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { resolveSubmitSettings } from "./resolve-submit-settings";

describe("resolveSubmitSettings", () => {
  const globals = {
    harnessId: "codex" as const,
    sandboxProviderKind: "user-desktop" as const,
    branch: "feature-x",
  };

  test("no active thread: returns all three from globals", () => {
    const out = resolveSubmitSettings({ thread: null, globals });
    expect(out).toEqual({
      harnessId: "codex",
      sandboxProviderKind: "user-desktop",
      branch: "feature-x",
    });
  });

  test("legacy thread with harness_id null: returns all three from globals", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: null,
        sandbox_provider_kind: null,
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({
      harnessId: "codex",
      sandboxProviderKind: "user-desktop",
      branch: "feature-x",
    });
  });

  test("locked thread: omits all three fields entirely (server reads from row)", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "claude-code",
        sandbox_provider_kind: "user-desktop",
        branch: "main",
      },
      globals,
    });
    expect(out).toEqual({});
  });

  test("locked thread with null sandbox/branch: still omits everything", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "decopilot",
        sandbox_provider_kind: null,
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({});
  });

  test("locked thread overrides aggressive globals (proves client-side strip)", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "codex",
        sandbox_provider_kind: "user-desktop",
        branch: "main",
      },
      globals: {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        branch: "different-branch",
      },
    });
    // No keys at all — the client must not even attempt to override.
    expect(Object.keys(out)).toEqual([]);
  });

  test("no active thread + no globals: returns empty undefined-valued fields", () => {
    const out = resolveSubmitSettings({
      thread: null,
      globals: {
        harnessId: undefined,
        sandboxProviderKind: undefined,
        branch: null,
      },
    });
    expect(out).toEqual({
      harnessId: undefined,
      sandboxProviderKind: undefined,
      branch: null,
    });
  });
});
```

- [ ] **Step 1.2: Run the test, confirm it fails**

Run: `bun test apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts`

Expected: failure with `Cannot find module './resolve-submit-settings'` (or equivalent).

- [ ] **Step 1.3: Create the helper file**

Create `apps/mesh/src/web/components/chat/resolve-submit-settings.ts`:

```ts
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

/**
 * Lock-aware submit-settings resolver.
 *
 * Once a thread row carries a non-null `harness_id`, the thread is "locked":
 * its harness, sandbox provider, and branch are immutable for the life of the
 * thread. The UI may still display the current global picker selection, but
 * the submit payload must NOT include those three fields — the server reads
 * them from the thread row.
 *
 * For unlocked threads (no row yet, or a legacy row with `harness_id IS
 * NULL`), the submit ships the user's current global picker selection.
 *
 * Pure function, no I/O. See spec:
 * docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
 */

export interface ResolveSubmitSettingsThread {
  harness_id?: string | null;
  sandbox_provider_kind?: string | null;
  branch?: string | null;
}

export interface ResolveSubmitSettingsGlobals {
  harnessId?: HarnessId;
  sandboxProviderKind?: SandboxProviderKind;
  branch?: string | null;
}

export interface ResolveSubmitSettingsResult {
  harnessId?: HarnessId;
  sandboxProviderKind?: SandboxProviderKind;
  branch?: string | null;
}

export function resolveSubmitSettings(args: {
  thread: ResolveSubmitSettingsThread | null;
  globals: ResolveSubmitSettingsGlobals;
}): ResolveSubmitSettingsResult {
  if (args.thread?.harness_id != null) {
    // Locked: omit all three. The server reads the truth from the row.
    return {};
  }
  return {
    harnessId: args.globals.harnessId,
    sandboxProviderKind: args.globals.sandboxProviderKind,
    branch: args.globals.branch ?? null,
  };
}
```

- [ ] **Step 1.4: Run the tests, confirm all pass**

Run: `bun test apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts`

Expected: 6 pass, 0 fail.

- [ ] **Step 1.5: Format, lint, type-check**

Run: `bun run fmt && bun run lint && bun run check`

Expected: clean.

- [ ] **Step 1.6: Commit**

```bash
git add apps/mesh/src/web/components/chat/resolve-submit-settings.ts \
        apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): add resolveSubmitSettings helper for thread lock

Pure function that decides whether the client should ship
harnessId / sandboxProviderKind / branch in submit RequestOptions
based on the thread row's lock state (harness_id != null).

Locked threads return {} — the server reads from the thread row.
Unlocked / new threads ship the user's current global picker.

Spec: docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
EOF
)"
```

---

## Task 2: Server-side lock guard in `validate()`

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/routes.ts` (function `validate()`, ~lines 236-316)
- Read for context: `apps/mesh/src/api/routes/decopilot/helpers.ts:401` (existing `ctx.storage.threads.get(taskId)` usage pattern)

**Why:** This is the actual enforcement of the lock. The client UI / helper is a courtesy; the server is the source of truth and must reject any client override on a locked thread. The guard must run **before** `resolvePerRequestModels(...)` so that model resolution uses the locked harness — otherwise we'd resolve models for the client-requested harness while dispatching to a different one, which is a worse correctness bug than the one we started with.

- [ ] **Step 2.1: Read the current `validate()` function**

Read `apps/mesh/src/api/routes/decopilot/routes.ts` lines 230-320.

Confirm:
- `harnessId`, `sandboxProviderKind`, `branch` are destructured from `validateRequest(c)` on lines 256-260.
- `taskIdInput` is computed on line 269.
- `resolvePerRequestModels(ctx, tier, harnessId)` is called on line 276 and depends on `harnessId`.
- The final return (lines 301-315) ships `branch`, `sandboxProviderKind`, `harnessId`.

- [ ] **Step 2.2: Add the lock guard**

Replace the current block from line 269 (`const taskIdInput = …`) through line 276 (the `resolvePerRequestModels` call) so that the guard runs between them. Concretely, after the existing line 269 (`const taskIdInput = threadIdParam ?? bodyThreadId;`), and after the existing lines 271-274 (the `userId` guard), insert the lock block, then change the `resolvePerRequestModels` call to use the effective harness, and finally use the effective values in the returned object.

After the existing line:
```ts
  const taskIdInput = threadIdParam ?? bodyThreadId;
```

And after the existing user-id guard:
```ts
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    throw new HTTPException(401, { message: "User ID is required" });
  }
```

Insert:

```ts
  // Lock guard: once a thread row carries a non-null `harness_id`, the
  // thread's runtime (harness, sandbox provider, branch) is pinned for
  // life. Any client-provided override is silently dropped, and the
  // per-request model resolution below uses the locked harness so we
  // never dispatch with mismatched (harness, models).
  //
  // See spec:
  // docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
  let effectiveHarnessId = harnessId;
  let effectiveSandboxProviderKind = sandboxProviderKind;
  let effectiveBranch = branch;
  if (taskIdInput) {
    const thread = await ctx.storage.threads.get(taskIdInput);
    if (thread?.harness_id) {
      if (harnessId && harnessId !== thread.harness_id) {
        console.warn(
          "decopilot.submit: ignored harness override on locked thread",
          {
            threadId: taskIdInput,
            requested: harnessId,
            locked: thread.harness_id,
          },
        );
      }
      effectiveHarnessId = thread.harness_id as HarnessId;
      effectiveSandboxProviderKind =
        (thread.sandbox_provider_kind as SandboxProviderKind | null) ??
        undefined;
      effectiveBranch = thread.branch ?? null;
    }
  }
```

Then change the model resolution call on line 276 from:

```ts
  const resolvedModels = await resolvePerRequestModels(ctx, tier, harnessId);
```

To:

```ts
  const resolvedModels = await resolvePerRequestModels(
    ctx,
    tier,
    effectiveHarnessId,
  );
```

And change the returned object (lines 301-315) so the locked values flow out:

```ts
  return {
    messages: [...systemMessages, requestMessage],
    models,
    agent,
    temperature,
    toolApprovalLevel,
    mode,
    organizationId: organization.id,
    userId,
    taskId: taskIdInput,
    windowSize: memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE,
    branch: effectiveBranch ?? null,
    sandboxProviderKind: effectiveSandboxProviderKind ?? null,
    harnessId: effectiveHarnessId ?? null,
  };
```

**Notes for the implementer:**
- `console.warn` is intentional here — `validate()` does not currently take a logger parameter and the file's existing observability is via OpenTelemetry attributes set later in `dispatch-run.ts`. A warn log on `console` is the minimum-friction surface for now and matches the audit-trail intent ("did a stale client try to drift this thread?"). Do not add an OTel span attribute here unless a similar pattern is already in `validate()`.
- The `as HarnessId` / `as SandboxProviderKind | null` casts are needed because `Thread.harness_id` and `Thread.sandbox_provider_kind` are typed as `string | null`. This is acceptable because the values were originally written by this same code path (which constrains them to the union); a runtime check is unnecessary here.

- [ ] **Step 2.3: Add an integration test for the guard**

Look at existing tests in the directory: `apps/mesh/src/api/routes/decopilot/run-config.test.ts`, `apps/mesh/src/api/routes/decopilot/on-title-updated.test.ts`, and the resilience tests under `tests/resilience/scenarios/`. Pick the pattern that exercises a real submit through the route.

The minimal viable test: create a thread row with `harness_id = "codex"`, `sandbox_provider_kind = "user-desktop"`, `branch = "main"`. Call `validate()` (or the route that wraps it) with a body that sets `harnessId: "claude-code"`, `sandboxProviderKind: "cluster"`, `branch: "feature-x"`. Assert the returned `DispatchRunInput` has `harnessId: "codex"`, `sandboxProviderKind: "user-desktop"`, `branch: "main"`.

If a route-level test scaffold already exists in the folder, prefer extending it. If not, write a smaller integration test that imports `validate` directly and mocks only `ctx.storage.threads.get` and `validateRequest`.

Run: `bun test apps/mesh/src/api/routes/decopilot/`

Expected: new test passes; existing tests still pass.

- [ ] **Step 2.4: Format, lint, type-check**

Run: `bun run fmt && bun run lint && bun run check`

Expected: clean.

- [ ] **Step 2.5: Commit**

```bash
git add apps/mesh/src/api/routes/decopilot/routes.ts \
        apps/mesh/src/api/routes/decopilot/  # whichever test file was added
git commit -m "$(cat <<'EOF'
fix(decopilot): lock thread harness, sandbox, branch in validate()

Once threads.harness_id is non-null the thread's runtime is pinned for
life. validate() now loads the thread before resolvePerRequestModels and
silently overrides any client-supplied harnessId / sandboxProviderKind /
branch from the row. This is the actual enforcement point; client UI is
just affordance.

Logs a console.warn when a stale client tries to drift so we can spot
the source.

Spec: docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
EOF
)"
```

---

## Task 3: Inverse helper `agentOptionFor` in `agent-options.ts`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/agent-options.ts`

**Why:** The chat context needs to map a locked `(harness_id, sandbox_provider_kind)` tuple back to an `AgentOption` so the existing pill UI / submit code can read it transparently. The forward direction (`AgentOption → {harness, sandbox}`) exists as `AGENT_OPTION_PINS`; the inverse is missing.

- [ ] **Step 3.1: Read the current file**

Read `apps/mesh/src/web/components/chat/pills/agent-options.ts`. It's 22 lines.

- [ ] **Step 3.2: Add the inverse helper**

Append to the file:

```ts
/**
 * Inverse of `AGENT_OPTION_PINS`. Maps a (harness, sandbox) tuple — typically
 * sourced from `threads.harness_id` + `threads.sandbox_provider_kind` on a
 * locked thread — back to the canonical `AgentOption`.
 *
 * Returns `null` when the pair does not correspond to any known option (which
 * can happen for legacy or trigger-created rows that wrote a harness without
 * going through this picker).
 */
export function agentOptionFor(
  harness: HarnessId | null,
  sandbox: SandboxProviderKind | null,
): AgentOption | null {
  if (!harness) return null;
  for (const [option, pins] of Object.entries(AGENT_OPTION_PINS) as [
    AgentOption,
    AgentPins,
  ][]) {
    if (pins.harness === harness && pins.sandbox === sandbox) {
      return option;
    }
  }
  return null;
}
```

- [ ] **Step 3.3: Add a co-located unit test**

Create `apps/mesh/src/web/components/chat/pills/agent-options.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { AGENT_OPTION_PINS, agentOptionFor } from "./agent-options";

describe("agentOptionFor", () => {
  test("maps decopilot harness with null sandbox to decopilot option", () => {
    expect(agentOptionFor("decopilot", null)).toBe("decopilot");
  });

  test("maps claude-code + user-desktop to claude-code-desktop", () => {
    expect(agentOptionFor("claude-code", "user-desktop")).toBe(
      "claude-code-desktop",
    );
  });

  test("maps codex + user-desktop to codex-desktop", () => {
    expect(agentOptionFor("codex", "user-desktop")).toBe("codex-desktop");
  });

  test("returns null for unknown harness", () => {
    // @ts-expect-error — deliberately passing an out-of-union value
    expect(agentOptionFor("unknown-harness", null)).toBeNull();
  });

  test("returns null for null harness", () => {
    expect(agentOptionFor(null, "user-desktop")).toBeNull();
  });

  test("round-trips against AGENT_OPTION_PINS", () => {
    for (const [option, pins] of Object.entries(AGENT_OPTION_PINS)) {
      expect(agentOptionFor(pins.harness, pins.sandbox)).toBe(option);
    }
  });
});
```

- [ ] **Step 3.4: Run tests, format, lint, type-check**

Run: `bun test apps/mesh/src/web/components/chat/pills/agent-options.test.ts && bun run fmt && bun run lint && bun run check`

Expected: 6 pass; clean lint/format/types.

- [ ] **Step 3.5: Commit**

```bash
git add apps/mesh/src/web/components/chat/pills/agent-options.ts \
        apps/mesh/src/web/components/chat/pills/agent-options.test.ts
git commit -m "feat(chat): add agentOptionFor() inverse of AGENT_OPTION_PINS"
```

---

## Task 4: Wire thread-lock state into `chat-context.tsx`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/chat-context.tsx`

**Why:** This is the central wiring change. Replace the proxy `isBranchLocked` predicate with `isThreadLocked` based on `activeTask?.harness_id != null`. Expose `lockedHarness`, `lockedSandbox`, `lockedBranch` on the task context so the input / pickers can read them. Make `effectiveAgentOption` lock-aware so the existing downstream `pendingHarnessId` / `pendingSandboxProviderKind` derive correctly without further plumbing changes.

- [ ] **Step 4.1: Update the `ChatTaskContextValue` type (around line 140)**

Read `apps/mesh/src/web/components/chat/chat-context.tsx` lines 138-160 first to confirm the interface body.

Replace the current `isBranchLocked: boolean;` line and the surrounding three or four lines so the interface has, in this order:

```ts
  activeTask: Task | null;
  /** True iff the thread row has captured a `harness_id` — i.e. the first
   *  message has been processed and the runtime is pinned for life. */
  isThreadLocked: boolean;
  /** Locked harness for the active thread (null when unlocked / no thread). */
  lockedHarness: HarnessId | null;
  /** Locked sandbox provider kind (null when unlocked, or harness has no sandbox). */
  lockedSandbox: SandboxProviderKind | null;
  /** Locked branch (null when unlocked or thread has no branch). */
  lockedBranch: string | null;
  currentBranch: string | null;
```

Remove the standalone `isBranchLocked: boolean;` line if it remains.

Confirm the imports at the top of the file already include `HarnessId` and `SandboxProviderKind`; if not, add them (the existing `AgentOption` import on line 45 imports `AGENT_OPTION_PINS` and `AgentOption` from `./pills/agent-options`; `HarnessId` comes from `@/harnesses` and `SandboxProviderKind` from `@decocms/sandbox/provider`).

- [ ] **Step 4.2: Compute the lock values (around line 633)**

Read lines 630-640. Replace lines 635-636 (`const currentBranch …` and `const isBranchLocked …`) with:

```ts
  const lockedHarness = (activeTask?.harness_id ?? null) as HarnessId | null;
  const lockedSandbox = (activeTask?.sandbox_provider_kind ?? null) as
    | SandboxProviderKind
    | null;
  const lockedBranch = activeTask?.branch ?? null;
  const isThreadLocked = lockedHarness != null;

  // Existing call sites still read `currentBranch` for create-task carry-over;
  // it stays a separate alias so we don't have to touch every reference.
  const currentBranch = lockedBranch;
```

- [ ] **Step 4.3: Make `effectiveAgentOption` lock-aware (around line 521)**

Read lines 518-534 first. The current computation derives `effectiveAgentOption` from `pendingAgentOption` and `hasClonableSource`. We need to add a higher-priority branch: when locked, derive from `(lockedHarness, lockedSandbox)`.

Replace lines 521-527 (the `effectiveAgentOption` declaration) with:

```ts
  // When the thread is locked, the agent option is dictated by the persisted
  // (harness, sandbox) pair — period. Otherwise, fall through to the user's
  // global picker, modulo the existing clonable-source fallback.
  const lockedAgentOption = isThreadLocked
    ? agentOptionFor(lockedHarness, lockedSandbox)
    : null;
  const effectiveAgentOption: AgentOption | null =
    lockedAgentOption ??
    (pendingAgentOption === null
      ? null
      : !hasClonableSource &&
          AGENT_OPTION_PINS[pendingAgentOption].sandbox === "user-desktop"
        ? "decopilot"
        : pendingAgentOption);
```

Add `agentOptionFor` to the existing import on line 45:

```ts
import {
  AGENT_OPTION_PINS,
  agentOptionFor,
  type AgentOption,
} from "./pills/agent-options";
```

**Critical context:** `effectiveAgentOption` is computed in `ChatPrefsProvider` (outer), which is *outside* the `ActiveTaskProvider` scope where `activeTask` is currently read. You may need to thread `isThreadLocked` / `lockedHarness` / `lockedSandbox` through props or via context lookup. Read lines 341-380 (ChatPrefsProvider signature) and lines 630-700 (ActiveTaskProvider) before making this edit — pick the path that minimizes provider-tree shuffling. If `ChatPrefsProvider` is wrapped by something that already knows the active task, hoist; otherwise, add a small `useActiveThreadLockReader()` hook that reads from `ChatTaskContextValue` and is called inside `ChatPrefsProvider`. Document the choice in a code comment.

- [ ] **Step 4.4: Expose new values on the task context value (around line 695)**

Read lines 695-710. Replace the existing `taskValue` object so it returns the renamed and new fields:

```ts
  const taskValue: ChatTaskContextValue = {
    virtualMcpId: effectiveVirtualMcpId,
    taskId: effectiveTaskId,
    openTask: navigateToTask,
    createTask,
    createTaskWithMessage,
    activeTask,
    isThreadLocked,
    lockedHarness,
    lockedSandbox,
    lockedBranch,
    currentBranch,
    setCurrentTaskBranch: (branch: string | null) => {
      // ... existing body unchanged
```

Keep the existing `setCurrentTaskBranch` body as-is.

- [ ] **Step 4.5: Replace the inline submit fields with `resolveSubmitSettings`**

Read lines 970-990 first. The current submit (lines 975-986) hardcodes:

```ts
        branch: currentBranch,
        sandboxProviderKind: pendingSandboxProviderKind || undefined,
        harnessId: pendingHarnessId || undefined,
```

Replace those three lines with a destructured call:

```ts
        ...resolveSubmitSettings({
          thread: activeTask
            ? {
                harness_id: activeTask.harness_id ?? null,
                sandbox_provider_kind: activeTask.sandbox_provider_kind ?? null,
                branch: activeTask.branch ?? null,
              }
            : null,
          globals: {
            harnessId: pendingHarnessId ?? undefined,
            sandboxProviderKind: pendingSandboxProviderKind ?? undefined,
            branch: currentBranch,
          },
        }),
```

Add the import near the top of the file:

```ts
import { resolveSubmitSettings } from "./resolve-submit-settings";
```

- [ ] **Step 4.6: Update every consumer of `isBranchLocked` to `isThreadLocked`**

Run a project-wide search for the old name:

```bash
# Use the Grep tool, not the Bash grep.
# Pattern: \bisBranchLocked\b
```

Expected hits (based on pre-implementation grep):
- `apps/mesh/src/web/components/chat/chat-context.tsx` (the type + the value)
- `apps/mesh/src/web/components/chat/input.tsx` (consumer that forwards into the mode-picker chain)

In `input.tsx`, find the line that destructures `isBranchLocked` from the chat task context and rename it to `isThreadLocked`. Find the prop being forwarded into `ChatModeRow` (which itself forwards to `ModePicker`) and rename. The downstream `mode-picker.tsx` `locked` prop name does not need to change — only the source of that boolean.

If `ChatModeRow` or `ModePicker` has its own prop named `locked` driven from `isBranchLocked`, do NOT rename the `locked` prop — only swap the value at the call site. Mode locking is downstream of the predicate; the predicate change is enough.

- [ ] **Step 4.7: Run client tests + the existing chat tests**

Run: `bun test apps/mesh/src/web/components/chat/`

Expected: pre-existing tests still pass; the helper test from Task 1 still passes.

- [ ] **Step 4.8: Format, lint, type-check**

Run: `bun run fmt && bun run lint && bun run check`

Expected: clean. Pay close attention to the type-check output — Task 4 is where compilation breaks are most likely (provider-tree wiring for `effectiveAgentOption`).

- [ ] **Step 4.9: Commit**

```bash
git add apps/mesh/src/web/components/chat/chat-context.tsx \
        apps/mesh/src/web/components/chat/input.tsx
git commit -m "$(cat <<'EOF'
feat(chat): source harness/sandbox/branch from thread row when locked

Replaces the proxy isBranchLocked predicate (keyed on branch presence)
with isThreadLocked (keyed on thread.harness_id != null), the actual
"thread runtime is pinned" condition.

Exposes lockedHarness / lockedSandbox / lockedBranch on the chat task
context, makes effectiveAgentOption lock-aware so the existing pill
display and submit derive the right (harness, sandbox) pair, and routes
the submit payload through resolveSubmitSettings so locked threads omit
the three fields entirely.

Server-side enforcement is the actual lock (see prior commit); this is
the client affordance that keeps the picker in sync with reality.

Spec: docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
EOF
)"
```

---

## Task 5: UI lock chip for the branch picker

**Files:**
- Modify: `apps/mesh/src/web/components/chat/input.tsx` (branch picker render block)

**Why:** The branch picker currently lets the user click it on an existing thread, but any change is moot — the submit takes the thread's branch. Show a lock icon + tooltip so the user understands why.

- [ ] **Step 5.1: Find the branch picker in `input.tsx`**

Grep for the branch picker component / pill within `input.tsx`. It's near line 600-630 (where `currentBranch` is forwarded into `ChatModeRow`). The exact component name will be something like `BranchPicker`, `BranchPill`, or inline JSX. Read 60 lines of context.

- [ ] **Step 5.2: Add a locked-chip rendering**

Inside the JSX of the branch picker (or at its call site, whichever owns the trigger render), conditionally render a disabled chip when `isThreadLocked` is true.

Concrete shape (adapt to the actual surrounding component — likely a Button or a Tooltip wrapper):

```tsx
{isThreadLocked ? (
  <Tooltip>
    <TooltipTrigger asChild>
      <div
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground cursor-default"
        aria-disabled="true"
      >
        <Lock className="h-3 w-3" aria-hidden="true" />
        <span>{lockedBranch ?? "(no branch)"}</span>
      </div>
    </TooltipTrigger>
    <TooltipContent>
      This chat is using branch {lockedBranch ?? "(none)"}.
      Start a new chat to use a different branch.
    </TooltipContent>
  </Tooltip>
) : (
  /* existing interactive branch picker JSX unchanged */
)}
```

Import the lock icon and tooltip primitives following the existing pattern in `input.tsx` — search the file for an existing `<Tooltip>` or icon import to match conventions (likely from `@decocms/ui` or `lucide-react`).

Pull `isThreadLocked` and `lockedBranch` from the chat task context using the existing context hook (search the file for `useChatTask()` or equivalent — the consumer pattern already exists for `currentBranch`).

- [ ] **Step 5.3: Visual smoke test (no automated test for this step)**

Run `bun run dev`. Open a chat. Confirm:
- New chat (no thread row): branch picker behaves as before, interactive.
- Send first message: picker becomes a chip with the lock icon and the branch name.
- Refresh / re-open the thread: chip is still locked.
- Hover the chip: tooltip with the expected copy.
- Mode-picker (harness picker) is also locked (this was already wired in Task 4).

- [ ] **Step 5.4: Format, lint, type-check**

Run: `bun run fmt && bun run lint && bun run check`

Expected: clean.

- [ ] **Step 5.5: Commit**

```bash
git add apps/mesh/src/web/components/chat/input.tsx
git commit -m "feat(chat): render locked-chip for branch picker on locked threads"
```

---

## Task 6: Tooltip copy + lock-icon polish for the mode-picker

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/mode-picker.tsx`

**Why:** The mode-picker `locked` prop already disables interaction (we just changed its source of truth in Task 4 from `isBranchLocked` to `isThreadLocked`). Update the tooltip copy so users understand it's the thread runtime that's locked, not specifically the branch.

- [ ] **Step 6.1: Read the mode-picker locked-state UI**

Read `apps/mesh/src/web/components/chat/pills/mode-picker.tsx` end-to-end (it's ~270 lines). Locate the tooltip / aria-label that fires when `locked` is true.

- [ ] **Step 6.2: Update the copy**

Replace any tooltip copy that mentions "branch" with copy that mentions the runtime. Example replacement:

```tsx
// Before (illustrative — adapt to actual file):
<TooltipContent>
  Locked to the branch this chat was started on.
</TooltipContent>

// After:
<TooltipContent>
  This chat is using {harnessLabel}. Start a new chat to use a different runtime.
</TooltipContent>
```

If the tooltip currently does not include a lock icon next to the harness label, add one (`<Lock className="h-3 w-3" aria-hidden />`) for visual consistency with the branch chip from Task 5.

`harnessLabel` should come from a small mapping — likely already exists; if not, define inline:

```ts
const HARNESS_LABEL: Record<HarnessId, string> = {
  decopilot: "Decopilot",
  "claude-code": "Claude Code",
  codex: "Codex",
};
```

If a label map already exists elsewhere (search for "Claude Code" string literals near mode picker code), reuse it; do not duplicate.

- [ ] **Step 6.3: Format, lint, type-check, smoke test**

Run: `bun run fmt && bun run lint && bun run check`

Run `bun run dev`. Open a locked thread. Confirm the mode-picker tooltip reads the new copy with the locked harness name.

- [ ] **Step 6.4: Commit**

```bash
git add apps/mesh/src/web/components/chat/pills/mode-picker.tsx
git commit -m "fix(chat): mode-picker lock tooltip names runtime, not branch"
```

---

## Task 7: Playwright E2E test

**Files:**
- Create: `apps/mesh/e2e/tests/chat-locked-thread.spec.ts`

**Why:** The unit + integration tests cover the helper and the server guard in isolation. This test proves the end-to-end behavior: a user who changes the global picker while one thread is open does not contaminate that thread's follow-up sends.

- [ ] **Step 7.1: Read an existing Playwright spec for scaffolding**

List files in `apps/mesh/e2e/tests/`. Open one (e.g. the most recently modified) and skim the test scaffolding: how authentication is set up, how a virtual MCP is created, how a thread is sent. Mirror the patterns.

- [ ] **Step 7.2: Write the test**

Create `apps/mesh/e2e/tests/chat-locked-thread.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// Adapt these helpers to whatever scaffolding the other specs in this folder
// use (sign-in helper, virtual-MCP factory, chat-page object).
import {
  signInAsTestUser,
  createVirtualMcp,
  openChat,
} from "./_helpers"; // <- replace with the actual shared helper module(s)

test.describe("Thread runtime is locked after first message", () => {
  test("changing global picker does not leak into a started thread", async ({
    page,
  }) => {
    await signInAsTestUser(page);
    const vmcp = await createVirtualMcp(page, { name: "Lock E2E" });

    // 1. Start a thread on Codex / main.
    await openChat(page, vmcp.id);
    await page.getByTestId("harness-picker").click();
    await page.getByRole("option", { name: /codex/i }).click();
    await page.getByTestId("branch-picker").click();
    await page.getByRole("option", { name: "main" }).click();

    await page.getByRole("textbox", { name: /message/i }).fill("hello");
    await page.getByRole("button", { name: /send/i }).click();

    // Wait for the first response to settle so the thread row's
    // harness_id is persisted.
    await expect(page.getByText(/hello/i)).toBeVisible();
    await expect(
      page.getByTestId("chat-running-indicator"),
    ).toBeHidden({ timeout: 30_000 });

    const threadUrl = page.url();

    // 2. Open a new chat and flip the global picker.
    await page.getByRole("button", { name: /new chat/i }).click();
    await page.getByTestId("harness-picker").click();
    await page.getByRole("option", { name: /claude code/i }).click();
    await page.getByTestId("branch-picker").click();
    await page.getByRole("option", { name: /feature-/i }).click();

    // 3. Return to the original thread.
    await page.goto(threadUrl);

    // 4. Both pickers render as locked chips with the original values.
    await expect(page.getByTestId("harness-picker-locked")).toContainText(
      /codex/i,
    );
    await expect(page.getByTestId("branch-picker-locked")).toContainText(
      "main",
    );

    // 5. Send a follow-up and capture the dispatched request.
    const submitWaiter = page.waitForRequest((req) =>
      req.url().includes("/decopilot/") && req.method() === "POST",
    );

    await page.getByRole("textbox", { name: /message/i }).fill("follow-up");
    await page.getByRole("button", { name: /send/i }).click();

    const submitReq = await submitWaiter;
    const body = submitReq.postDataJSON?.() ?? JSON.parse(submitReq.postData() ?? "{}");

    // Client must NOT ship the three locked fields for a locked thread.
    // (The server would override them anyway; this asserts the client
    // affordance is also correct.)
    expect(body.harnessId).toBeUndefined();
    expect(body.sandboxProviderKind).toBeUndefined();
    expect(body.branch).toBeUndefined();

    // 6. Reload and confirm the thread row still reports codex/main.
    await page.reload();
    await expect(page.getByTestId("harness-picker-locked")).toContainText(
      /codex/i,
    );
    await expect(page.getByTestId("branch-picker-locked")).toContainText(
      "main",
    );
  });

});

// Server-side override of a stale client submit is covered by the
// integration test added in Task 2 (`apps/mesh/src/api/routes/decopilot/`),
// which exercises `validate()` directly without an HTTP round-trip.
// Adding a Playwright equivalent here would duplicate that coverage.
```

**Implementer notes:**
- `_helpers` is a placeholder — replace with the actual shared helpers from sibling specs. Do not invent new infrastructure; reuse what the other specs in `apps/mesh/e2e/tests/` use.
- The `data-testid` values (`harness-picker`, `harness-picker-locked`, `branch-picker`, `branch-picker-locked`, `chat-running-indicator`) must match what the components render. If they do not exist today, add them as part of Tasks 4-6 (small additive change — not in a separate task). Update Task 5 / Task 6 to include the `data-testid` attributes if missing.
- The second test (`test.skip`) is documented as a placeholder because the request-fixture pattern depends on local helper scaffolding that varies; do not block the plan on it. The unit/integration tests in Task 1 + Task 2 cover the same surface deterministically.

- [ ] **Step 7.3: Run the E2E**

Run: `bun run --cwd=apps/mesh e2e` (or the project's documented Playwright entry; check `apps/mesh/package.json` for the exact script).

Expected: the new test passes; existing E2Es still pass.

- [ ] **Step 7.4: Format + lint**

Run: `bun run fmt && bun run lint`

Expected: clean.

- [ ] **Step 7.5: Commit**

```bash
git add apps/mesh/e2e/tests/chat-locked-thread.spec.ts
# Also add any data-testid additions if not already committed:
git add apps/mesh/src/web/components/chat/
git commit -m "test(chat): e2e — locked thread ignores global picker changes"
```

---

## Task 8: Final verification sweep

**Files:** none (verification only)

- [ ] **Step 8.1: Run the full suite**

Run, in order:

```bash
bun run fmt:check
bun run lint
bun run check
bun test
bun run --cwd=apps/mesh e2e   # or the project's Playwright entry
```

Expected: each command exits 0.

- [ ] **Step 8.2: Manual smoke**

Run `bun run dev`. Walk through:

1. Start a new chat with `claude-code-desktop` on branch `main`. Send a message.
2. Open a separate new-chat composer (e.g. press "New chat"). Switch to `codex-desktop`. Switch branch to a different branch.
3. Return to the first thread. Confirm the harness pill and branch picker render as locked chips with `Claude Code` and `main`. Hover both, confirm tooltip copy.
4. Send a follow-up in the first thread. Open DevTools network tab; inspect the request body. Confirm it does **not** include `harnessId`, `sandboxProviderKind`, or `branch`.
5. Confirm the response uses Claude Code (e.g. message reasoning style, or an in-app debug surface if one exists).
6. Open the second (new) chat composer again and confirm its pickers still show `codex-desktop` + the alternate branch (we haven't broken the new-chat flow).

- [ ] **Step 8.3: Verify dead-code / knip warnings**

Run `bun run lint` (or the documented knip command if it's separate). Confirm no warnings about unused exports from `resolve-submit-settings.ts` or `agent-options.ts`. If knip complains, that signals an import path was missed in Task 4; do not silence the warning — fix the import.

- [ ] **Step 8.4: No commit needed (verification only)**

If everything passes, the branch is ready for review. If anything fails, fix in a new commit on the same branch — do not amend.

---

## Spec Coverage Self-Review

Mapping spec sections → tasks:

| Spec section | Task |
|---|---|
| Scope of the lock (which fields are locked) | Tasks 2, 4 (server enforcement + client predicate) |
| Client read path | Tasks 3, 4 (inverse helper + lock-aware effectiveAgentOption) |
| Client write path | Tasks 1, 4 (pure helper + submit wiring) |
| Server — the actual lock | Task 2 |
| UI affordance | Tasks 4, 5, 6 (mode-picker via Task 4 + branch chip via Task 5 + copy via Task 6) |
| Edge cases (legacy null `harness_id`, race on first message, thread switch, trigger flows) | Covered by the uniform `harness_id != null` predicate baked into Tasks 1, 2, 4 |
| Unit tests | Tasks 1, 3 |
| E2E | Task 7 |

**Open risk acknowledged in the spec — addressed in the plan:**
- *"Trigger flows / automation paths."* The server guard in Task 2 covers all callers of `validate()` uniformly. A scan of trigger-issued submit call sites should be done as part of Task 8's manual smoke if any such path is suspected to set `harnessId` deliberately; the warn log on `console.warn` will surface any drift in production.
- *"AgentOption derivation."* Resolved in Task 3.

**Type consistency check:** all signatures (`resolveSubmitSettings`, `agentOptionFor`, the new `ChatTaskContextValue` fields, the renamed `isThreadLocked` prop) are defined exactly once each and used consistently across tasks.

No placeholders, no TBDs, no "implement appropriate error handling" hand-waving.
