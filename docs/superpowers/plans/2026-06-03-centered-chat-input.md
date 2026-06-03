# Centered Chat Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the central agent-icon + title + bottom-docked input on `/$org/$taskId` with a single vertically centered composer. Above the composer surface Branch + Harness pills (Q1, Q3, Q7). On first send, dock the input at the bottom and fold Branch + Harness inside its bottom row as disabled pills. Remove the BranchPill from the agent-shell header entirely.

**Architecture:** Two layouts, one input. `ChatPanelContent` picks `CenteredComposer` (new) when `isChatEmpty`, otherwise today's `Chat.Main`/`Chat.Footer` pair. `ChatModeRow` is extended to compose `BranchPill` alongside `ModePicker`, each gated by its own capability check. `Chat.Input` reads `isChatEmpty` and skips `ChatModeRow` in its bottom row when empty (it's above, rendered by `CenteredComposer`). `HeaderActions` loses its `BranchPill`.

**Tech Stack:** TypeScript 5.9, React 19 (no `useEffect`/`useMemo`/`useCallback`/`memo` per banned plugins), Tiptap (existing), Tailwind v4 with `animate-in fade-in-0` for the crossfade, Bun test runner (unit), Playwright (e2e).

**Source spec:** [`docs/superpowers/specs/2026-06-03-centered-chat-input-design.md`](../specs/2026-06-03-centered-chat-input-design.md)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx` | modify | Extend `ChatModeRowPure` + `ChatModeRow` to compose `BranchPill` + `ModePicker` with independent gates. |
| `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx` | modify | Extend pure-component tests for the BranchPill matrix (4 capability combinations + locked-state). |
| `apps/mesh/src/web/components/chat/centered-composer.tsx` | create | New leaf component. Composes above-row + `Chat.Input` + `Chat.IceBreakers`, vertically centered. ~60 lines. |
| `apps/mesh/src/web/components/chat/centered-composer.test.tsx` | create | Pure-component test for layout + read-only fallback. |
| `apps/mesh/src/web/components/chat/input.tsx` | modify | Wrap the `<ChatModeRow>` render site (lines ~621–624) in `{!isChatEmpty && (...)}`. `isChatEmpty` is already in scope. |
| `apps/mesh/src/web/components/chat/side-panel-chat.tsx` | modify | Replace `SidebarEmptyState` branch with `CenteredComposer`. Delete `SidebarEmptyState` function. |
| `apps/mesh/src/web/components/thread/github/header-actions.tsx` | modify | Remove the `<BranchPill>` block + preceding `<Separator>`. Trim unused imports. |
| `apps/mesh/e2e/tests/centered-input.spec.ts` | create | E2E coverage for empty → submitted transition, lock state, non-clonable variant. |

Tasks are ordered so that components are built bottom-up: extend the pills first, then the composer, then wire it into `ChatPanelContent`, finally clean up the header. The E2E test goes last because it covers the integrated behavior.

---

## Task 1: Extend `ChatModeRowPure` contract (failing tests first)

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`

- [ ] **Step 1: Replace the test file with the new matrix**

Today the test covers two cases (clonable vs not). The new contract has two independent slots — `branchPill` and `modePicker` — each of which may be `null`. The component returns `null` only when **both** are null.

Open `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx` and replace its full contents with:

```tsx
import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatModeRowPure } from "./chat-mode-row";

describe("ChatModeRowPure", () => {
  it("returns null when both pills are null", () => {
    const { container } = render(
      <ChatModeRowPure branchPill={null} modePicker={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders only the BranchPill when ModePicker is null", () => {
    const { getByTestId, queryByTestId } = render(
      <ChatModeRowPure
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={null}
      />,
    );
    expect(getByTestId("branch-pill")).toBeInTheDocument();
    expect(queryByTestId("mode-picker")).toBeNull();
  });

  it("renders only the ModePicker when BranchPill is null", () => {
    const { getByTestId, queryByTestId } = render(
      <ChatModeRowPure
        branchPill={null}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(getByTestId("mode-picker")).toBeInTheDocument();
    expect(queryByTestId("branch-pill")).toBeNull();
  });

  it("renders both pills, BranchPill before ModePicker", () => {
    const { getByTestId } = render(
      <ChatModeRowPure
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    const branch = getByTestId("branch-pill");
    const mode = getByTestId("mode-picker");
    expect(branch).toBeInTheDocument();
    expect(mode).toBeInTheDocument();
    // Branch comes first in document order so the user reads:
    // "branch [main] using [Cloud]" left-to-right.
    expect(
      branch.compareDocumentPosition(mode) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`

Expected: all four tests fail at the `<ChatModeRowPure ... />` call site — the component currently takes `clonable: boolean` (not `branchPill`) so TypeScript should reject this, and at runtime the imports won't even line up. This confirms the new contract isn't implemented yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx
git commit -m "test(chat): expand ChatModeRowPure matrix for BranchPill slot"
```

---

## Task 2: Update `ChatModeRowPure` to satisfy the new contract

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx`

- [ ] **Step 1: Replace the `PureProps` interface and `ChatModeRowPure` body**

Open `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx`. Replace the existing `PureProps` interface (lines 7–10) and the `ChatModeRowPure` function (lines 19–22) with this block:

```tsx
interface PureProps {
  branchPill: ReactNode;
  modePicker: ReactNode;
}

/**
 * Pure layout — used by tests. Each slot renders independently; the
 * component returns null only when BOTH are null.
 *
 * Renders as a fragment (no wrapping div) so the pills sit in the
 * parent flex flow with the same gap as their siblings.
 */
export function ChatModeRowPure({ branchPill, modePicker }: PureProps) {
  if (!branchPill && !modePicker) return null;
  return (
    <>
      {branchPill}
      {modePicker}
    </>
  );
}
```

- [ ] **Step 2: Run the pure-component tests and confirm they pass**

Run: `bun test apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`

Expected: 4 tests pass.

- [ ] **Step 3: Run TypeScript check**

Run: `bun run check`

Expected: type errors will surface at every `ChatModeRow` call site and inside the smart wrapper (it still passes `clonable`/`modePicker` shaped props). These will be fixed in Task 3. For now, note that the errors are confined to `chat-mode-row.tsx` (the smart wrapper) and not yet at any other file — the smart wrapper still passes the old props.

- [ ] **Step 4: Do NOT commit yet** — the smart wrapper still needs updating in the next task to compile.

---

## Task 3: Update the `ChatModeRow` smart wrapper to compose Branch + Harness

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx`

- [ ] **Step 1: Replace the `SmartProps` interface and `ChatModeRow` body**

In the same file (`apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx`), replace the existing `SmartProps` interface and `ChatModeRow` function (currently lines 24–51 after the Task 2 edit) with:

```tsx
interface SmartProps {
  virtualMcp: VirtualMCPEntity | null | undefined;
  currentBranch: string | null;
}

/**
 * Smart wrapper. Composes BranchPill + ModePicker. Each pill is gated
 * by its own capability check:
 *
 *   - BranchPill:  agent has an active GitHub repo
 *     (getActiveGithubRepo(virtualMcp) is non-null).
 *   - ModePicker:  agent is clonable
 *     (agentHasClonableSource(virtualMcp?.metadata)).
 *
 * Locked flag is derived once here from
 * `useOptionalChatStream().messages.length > 0` and passed to both.
 */
export function ChatModeRow({ virtualMcp, currentBranch }: SmartProps) {
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;

  const clonable = agentHasClonableSource(virtualMcp?.metadata);
  const githubRepo = getActiveGithubRepo(virtualMcp);

  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const { org } = useProjectContext();

  const branchPill = githubRepo ? (
    <BranchPill
      orgId={org.id}
      orgSlug={org.slug}
      userId={userId}
      virtualMcpId={virtualMcp?.id ?? ""}
      connectionId={githubRepo.connectionId ?? ""}
      owner={githubRepo.owner}
      repo={githubRepo.name}
      sandboxMap={virtualMcp?.metadata?.sandboxMap}
      value={currentBranch}
      onChange={(next) => void setCurrentTaskBranch?.(next)}
      locked={locked}
      placement="chat"
    />
  ) : null;

  const modePicker = clonable ? (
    <ModePicker
      locked={locked}
      currentBranch={currentBranch}
      virtualMcpId={virtualMcp?.id ?? ""}
    />
  ) : null;

  return <ChatModeRowPure branchPill={branchPill} modePicker={modePicker} />;
}
```

- [ ] **Step 2: Add the new imports at the top of the file**

The file currently imports `agentHasClonableSource` and `useOptionalChatStream`. Add the additional imports needed by the new body. Replace the existing import block at the top of `chat-mode-row.tsx` with:

```tsx
import type { ReactNode } from "react";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useOptionalChatStream, useOptionalChatTask } from "../context";
import { ModePicker } from "./mode-picker";
import { BranchPill } from "./branch-pill";
import { getActiveGithubRepo } from "@/web/lib/github-repo";
import { useProjectContext } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
```

- [ ] **Step 3: Wire `setCurrentTaskBranch` via the chat-task context**

The smart wrapper needs `setCurrentTaskBranch` to write the user's branch choice. Today, `Chat.Input` passes `currentBranch` to `ChatModeRow` but the writer lives on the chat-task context. Read it via `useOptionalChatTask`. In the `ChatModeRow` body added in Step 1, replace the line:

```tsx
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;
```

with:

```tsx
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;
  const taskCtx = useOptionalChatTask();
  const setCurrentTaskBranch = taskCtx?.setCurrentTaskBranch;
```

Then change the BranchPill `onChange` from:

```tsx
      onChange={(next) => void setCurrentTaskBranch?.(next)}
```

to (drop the optional chaining since the const is captured above):

```tsx
      onChange={(next) => {
        if (setCurrentTaskBranch) void setCurrentTaskBranch(next);
      }}
```

- [ ] **Step 4: Run TypeScript check**

Run: `bun run check`

Expected: no errors in `chat-mode-row.tsx` or any of its callers (`input.tsx`, `header-actions.tsx`). The smart wrapper's external prop surface (`virtualMcp`, `currentBranch`) is unchanged from before, so no call site needs updating yet.

If the check fails with an error inside `chat-mode-row.tsx` because `useOptionalChatTask` is not exported from `../context`, run:

```
grep -n "useOptionalChatTask\|useChatTask" apps/mesh/src/web/components/chat/context.tsx apps/mesh/src/web/components/chat/index.tsx
```

If only `useChatTask` exists (throws when no provider), use it inside a try/catch is wrong — instead, expose an optional variant. Open `apps/mesh/src/web/components/chat/context.tsx` and look for `useChatTask`'s definition. Add a sibling export `useOptionalChatTask` that returns `null` when the context is missing, mirroring the existing `useOptionalChatStream` pattern. (Both `chat-context.tsx` and `chat/index.tsx` re-export from `context.tsx` in this codebase — follow whichever pattern the file uses.)

- [ ] **Step 5: Run the pure-component tests once more**

Run: `bun test apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`

Expected: 4 tests still pass.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx \
        apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx \
        apps/mesh/src/web/components/chat/context.tsx
git commit -m "feat(chat): compose BranchPill + ModePicker in ChatModeRow"
```

(Drop `context.tsx` from the `git add` line if Step 4 didn't require touching it.)

---

## Task 4: Write the failing `CenteredComposer` pure-component test

**Files:**
- Create: `apps/mesh/src/web/components/chat/centered-composer.test.tsx`

- [ ] **Step 1: Create the test file**

Create `apps/mesh/src/web/components/chat/centered-composer.test.tsx` with these contents. The pure-component test exercises a `CenteredComposerPure` export (the smart wrapper reads context and is covered by E2E later):

```tsx
import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CenteredComposerPure } from "./centered-composer";

describe("CenteredComposerPure", () => {
  it("renders above-row, input, and icebreakers in vertical order", () => {
    const { getByTestId } = render(
      <CenteredComposerPure
        readOnly={false}
        aboveRow={<div data-testid="above-row">above</div>}
        input={<div data-testid="input">input</div>}
        iceBreakers={<div data-testid="ice-breakers">ice</div>}
      />,
    );
    const above = getByTestId("above-row");
    const input = getByTestId("input");
    const ice = getByTestId("ice-breakers");
    expect(above).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(ice).toBeInTheDocument();
    expect(
      above.compareDocumentPosition(input) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      input.compareDocumentPosition(ice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("applies centering layout classes to the outer wrapper", () => {
    const { container } = render(
      <CenteredComposerPure
        readOnly={false}
        aboveRow={null}
        input={<div data-testid="input">input</div>}
        iceBreakers={null}
      />,
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.className).toContain("items-center");
    expect(outer.className).toContain("justify-center");
  });

  it("hides above-row and icebreakers when read-only", () => {
    const { queryByTestId, getByTestId } = render(
      <CenteredComposerPure
        readOnly={true}
        aboveRow={<div data-testid="above-row">above</div>}
        input={<div data-testid="input">input</div>}
        iceBreakers={<div data-testid="ice-breakers">ice</div>}
      />,
    );
    expect(queryByTestId("above-row")).toBeNull();
    expect(queryByTestId("ice-breakers")).toBeNull();
    expect(getByTestId("input")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test apps/mesh/src/web/components/chat/centered-composer.test.tsx`

Expected: all three tests fail — the file `centered-composer.tsx` does not exist yet, so the import resolves to nothing.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/mesh/src/web/components/chat/centered-composer.test.tsx
git commit -m "test(chat): add pure-component test for CenteredComposer"
```

---

## Task 5: Implement `CenteredComposer`

**Files:**
- Create: `apps/mesh/src/web/components/chat/centered-composer.tsx`

- [ ] **Step 1: Create the component file**

Create `apps/mesh/src/web/components/chat/centered-composer.tsx` with these contents:

```tsx
/**
 * CenteredComposer — empty-state composer for /$org/$taskId.
 *
 * Renders:
 *   above-row (Branch + Harness pills, unlocked, gated by capability)
 *   centered Chat.Input
 *   icebreakers (below the input)
 *
 * Mounted by ChatPanelContent when isChatEmpty is true. The pure
 * variant takes pre-rendered slot nodes so it's trivially testable
 * without mocking MeshContext, virtual-MCP queries, or auth state.
 *
 * Read-only fallback: when the active task was created by someone else
 * the above-row and icebreakers are hidden — Chat.Input then renders
 * its own "Read only" banner.
 */
import type { ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useVirtualMCP, useProjectContext } from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { Chat } from "./index";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { ChatModeRow } from "./pills/chat-mode-row";

interface PureProps {
  readOnly: boolean;
  aboveRow: ReactNode;
  input: ReactNode;
  iceBreakers: ReactNode;
}

export function CenteredComposerPure({
  readOnly,
  aboveRow,
  input,
  iceBreakers,
}: PureProps) {
  return (
    <div
      className={cn(
        "h-full w-full flex flex-col items-center justify-center px-4 gap-6",
      )}
    >
      <div className="w-full max-w-3xl flex flex-col gap-3">
        {!readOnly && aboveRow ? (
          <div className="flex justify-center gap-2">{aboveRow}</div>
        ) : null}
        {input}
        {!readOnly && iceBreakers ? (
          <div className="w-full">{iceBreakers}</div>
        ) : null}
      </div>
    </div>
  );
}

interface Props {
  onOpenContextPanel: () => void;
}

export function CenteredComposer({ onOpenContextPanel }: Props) {
  const { org } = useProjectContext();
  const { selectedVirtualMcp } = useChatPrefs();
  // Resolve the default agent the same way ChatPanelContent does for
  // its empty-state path — this keeps CenteredComposer self-contained.
  const displayAgent = selectedVirtualMcp;
  const fullVm = useVirtualMCP(displayAgent?.id ?? "");
  const taskCtx = useOptionalChatTask();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const task = taskCtx?.activeTask ?? null;
  const readOnly = Boolean(
    userId && task?.created_by && task.created_by !== userId,
  );

  return (
    <CenteredComposerPure
      readOnly={readOnly}
      aboveRow={
        <ChatModeRow
          virtualMcp={fullVm}
          currentBranch={taskCtx?.currentBranch ?? null}
        />
      }
      input={<Chat.Input onOpenContextPanel={onOpenContextPanel} />}
      iceBreakers={<Chat.IceBreakers />}
    />
  );
}
```

> Note on `org` import: it is used only to keep the data-flow comments accurate; if `bun run check` flags it as unused, remove the binding (`const { org: _ } = useProjectContext();` is not allowed by the lint plugins — just drop the destructure line).

- [ ] **Step 2: Run the pure-component test**

Run: `bun test apps/mesh/src/web/components/chat/centered-composer.test.tsx`

Expected: all three tests pass.

- [ ] **Step 3: Run TypeScript check**

Run: `bun run check`

Expected: no errors. If `useChatPrefs` or `Chat.IceBreakers` import paths are off, fix by reading the existing imports in `side-panel-chat.tsx` (which already uses both) and matching them exactly.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/centered-composer.tsx
git commit -m "feat(chat): add CenteredComposer for empty-state layout"
```

---

## Task 6: Make `Chat.Input` skip `ChatModeRow` when empty

**Files:**
- Modify: `apps/mesh/src/web/components/chat/input.tsx`

- [ ] **Step 1: Wrap the `<ChatModeRow>` render site in `{!isChatEmpty && (...)}`**

Open `apps/mesh/src/web/components/chat/input.tsx`. Find the block around line 619–624 inside the right-actions container:

```tsx
                    {/* Right Actions (branch/mode, model, mic, send) */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ChatModeRow
                        virtualMcp={fullVm}
                        currentBranch={taskCtx?.currentBranch ?? null}
                      />
                      <TierTrigger />
```

Replace the `<ChatModeRow>` JSX element with the conditional:

```tsx
                    {/* Right Actions (branch/mode, model, mic, send) */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      {!isChatEmpty && (
                        <ChatModeRow
                          virtualMcp={fullVm}
                          currentBranch={taskCtx?.currentBranch ?? null}
                        />
                      )}
                      <TierTrigger />
```

The `isChatEmpty` variable is already destructured from `useChatStream()` higher up in the function (`const { isChatEmpty } = useChatStream();` — confirm by reading lines ~250–270 in the file before this edit; if the field has a different local name, use that name). No new prop, no new hook.

- [ ] **Step 2: Run the input's existing unit tests, if any**

Run: `bun test apps/mesh/src/web/components/chat/`

Expected: existing tests still pass. (`chat-mode-row.test.tsx` and `centered-composer.test.tsx` from earlier tasks are unaffected.)

- [ ] **Step 3: Run TypeScript check**

Run: `bun run check`

Expected: no new errors.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/input.tsx
git commit -m "feat(chat): skip ChatModeRow in input bottom row when empty"
```

---

## Task 7: Wire `CenteredComposer` into `ChatPanelContent` and delete `SidebarEmptyState`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/side-panel-chat.tsx`

- [ ] **Step 1: Add the import for `CenteredComposer`**

Open `apps/mesh/src/web/components/chat/side-panel-chat.tsx`. After the existing `import { Chat } from "./index";` line near the top, add:

```tsx
import { CenteredComposer } from "./centered-composer";
```

- [ ] **Step 2: Replace the chat-view JSX inside `ChatPanelContent`**

Find this block (around lines 107–122 in the current file):

```tsx
      {/* Chat view */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel !== "chat"
            ? "opacity-0 pointer-events-none"
            : "opacity-100",
        )}
      >
        <Chat.Main>
          {!isChatEmpty ? <Chat.Messages /> : <SidebarEmptyState />}
        </Chat.Main>
        <Chat.Footer>
          <Chat.Input onOpenContextPanel={() => setActivePanel("context")} />
        </Chat.Footer>
      </div>
```

Replace it with:

```tsx
      {/* Chat view */}
      <div
        className={cn(
          "absolute inset-0 flex flex-col transition-opacity duration-100 ease-out",
          activePanel !== "chat"
            ? "opacity-0 pointer-events-none"
            : "opacity-100",
        )}
      >
        {isChatEmpty ? (
          <Chat.Main
            className={cn(
              "flex flex-col items-center justify-center",
              "animate-in fade-in-0 duration-200",
            )}
          >
            <CenteredComposer
              onOpenContextPanel={() => setActivePanel("context")}
            />
          </Chat.Main>
        ) : (
          <>
            <Chat.Main className="animate-in fade-in-0 duration-200">
              <Chat.Messages />
            </Chat.Main>
            <Chat.Footer>
              <Chat.Input
                onOpenContextPanel={() => setActivePanel("context")}
              />
            </Chat.Footer>
          </>
        )}
      </div>
```

- [ ] **Step 3: Delete the now-unused `SidebarEmptyState` function**

In the same file, delete the `SidebarEmptyState` function (currently lines 27–57 — the `// ---------- Default sidebar empty state ----------` block plus the function body). Also remove imports that become unused after the deletion. Specifically:

- `IntegrationIcon` — was only used by `SidebarEmptyState`.
- `getWellKnownDecopilotVirtualMCP` — was only used by `SidebarEmptyState`.
- `Users03` from `@untitledui/icons` — was only used by `SidebarEmptyState`.

Run `bun run check` after deletion; the TypeScript compiler will report any other dangling imports.

- [ ] **Step 4: Run TypeScript check**

Run: `bun run check`

Expected: clean. If there are unused-import warnings, remove the offending imports (do not silence them).

- [ ] **Step 5: Smoke test in the browser**

```bash
bun run dev
```

Then in a browser:
- Open `http://localhost:4000`, sign in, navigate to a clonable-agent thread that has zero messages.
- Confirm the centered layout: above-row with Branch + Harness pills, input centered, icebreakers below.
- Type something, hit Enter. Confirm the input docks to the bottom and Branch + Harness now render disabled inside its bottom row. Confirm a crossfade is visible (no hard cut).
- Open a thread for a non-clonable agent (e.g. plain Decopilot) with zero messages. Confirm: no above-row, just the centered input + icebreakers.

Stop dev server with Ctrl-C.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/side-panel-chat.tsx
git commit -m "feat(chat): swap SidebarEmptyState for CenteredComposer in ChatPanelContent"
```

---

## Task 8: Remove `BranchPill` from `HeaderActions`

**Files:**
- Modify: `apps/mesh/src/web/components/thread/github/header-actions.tsx`

- [ ] **Step 1: Remove the BranchPill JSX and preceding Separator**

Open `apps/mesh/src/web/components/thread/github/header-actions.tsx`. Find the return block (currently lines 295–333):

```tsx
  return (
    <>
      <Separator
        orientation="vertical"
        className="mx-2 data-[orientation=vertical]:h-5"
      />
      <div className="flex items-center gap-2">
        <BranchPill
          orgId={org.id}
          orgSlug={org.slug}
          userId={userId ?? ""}
          virtualMcpId={virtualMcpId}
          connectionId={githubRepo.connectionId ?? ""}
          owner={githubRepo.owner}
          repo={githubRepo.name}
          sandboxMap={vm?.metadata?.sandboxMap}
          value={branch ?? sandboxRouteBranch ?? null}
          onChange={(next) => void setCurrentTaskBranch(next)}
          locked={branchPickerLocked}
          placement="header"
        />
        <HeaderButtonRenderer
          button={button}
          actionBusy={actionBusy}
          ...
        />
      </div>
      ...
```

Replace the wrapper `<div className="flex items-center gap-2">…</div>` (with both children) and the preceding `<Separator>` so that the next-action button is rendered directly:

```tsx
  return (
    <>
      <HeaderButtonRenderer
        button={button}
        actionBusy={actionBusy}
        githubActionPending={githubActionPending}
        onActivate={onActivate}
        prNumber={pr?.number}
        prBase={pr?.base}
        onSquashMerge={handleSquashMerge}
        onReview={
          pr
            ? () => {
                if (isStreaming) return;
                void send(tpl.reviewPr({ prNumber: pr.number }));
              }
            : undefined
        }
      />
      ...
```

Preserve everything else after the `</div>` (the `{sandboxRouteBranch && (<PublishDialog ... />)}` block and the trailing `</>`).

- [ ] **Step 2: Remove the `branchPickerLocked` derivation if it's now unused**

The line `const branchPickerLocked = (chat.messages ?? []).length > 0;` was added only to feed `BranchPill`. After Step 1 it has no consumer. Delete that line.

If `chat.messages` is read elsewhere in this file, leave the `chat` binding alone — only delete the `branchPickerLocked` const itself.

- [ ] **Step 3: Remove dead imports**

Delete the import of `BranchPill`:

```tsx
import { BranchPill } from "../../chat/pills/branch-pill.tsx";
```

Delete the import of `Separator` if `bun run check` confirms it's no longer used in this file:

```tsx
import { Separator } from "@deco/ui/components/separator.tsx";
```

(If `Separator` is still used elsewhere in the file, leave it.)

- [ ] **Step 4: Run TypeScript check**

Run: `bun run check`

Expected: clean. If a hook or query result became unused as a result of removing the BranchPill (`org`, `userId`, `setCurrentTaskBranch`, `vm?.metadata?.sandboxMap` — most of these still feed the action button via other paths), remove only the bindings that the compiler flags as unused. Do not over-remove.

- [ ] **Step 5: Smoke test in the browser**

```bash
bun run dev
```

Open a thread for a clonable agent. Verify the agent-shell header now shows only the next-action button ("Save changes" / "Open PR" / etc.) — no BranchPill, no leading separator before it.

Confirm that switching the Branch via the pill inside the chat input (above-row when empty, or disabled inside the input when submitted) still updates the in-memory state, and that opening a published PR / save-changes flow still works end-to-end.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/thread/github/header-actions.tsx
git commit -m "feat(chat): remove BranchPill from HeaderActions"
```

---

## Task 9: E2E test for the new layout and lock transitions

**Files:**
- Create: `apps/mesh/e2e/tests/centered-input.spec.ts`

- [ ] **Step 1: Add `data-*` attributes the test will key on**

For the test to be robust, mark the three relevant DOM nodes with stable `data-*` attributes. Edit the following three files:

In `apps/mesh/src/web/components/chat/centered-composer.tsx`, change the outer wrapper of `CenteredComposerPure` to include a test attribute:

```tsx
    <div
      data-chat-centered="true"
      className={cn(
        "h-full w-full flex flex-col items-center justify-center px-4 gap-6",
      )}
    >
```

In the same file's `CenteredComposerPure`, change the above-row inner wrapper to:

```tsx
        {!readOnly && aboveRow ? (
          <div data-chat-above-row="true" className="flex justify-center gap-2">
            {aboveRow}
          </div>
        ) : null}
```

In `apps/mesh/src/web/components/chat/input.tsx`, find the docked-input `<form>` element (around line 461–466) and add `data-chat-docked-input="true"` to it. Use whatever distinguishing attribute already lives on the form/its outer wrapper as a sibling — the goal is just to give Playwright a single hook to assert "the docked input is mounted, not the centered one."

- [ ] **Step 2: Create the E2E test file**

Create `apps/mesh/e2e/tests/centered-input.spec.ts`. Use the existing chat-input draft spec (`apps/mesh/e2e/tests/chat-input-draft.spec.ts`) as the structural reference for fixtures, sign-in, and how to navigate to a thread.

```tsx
/**
 * E2E: centered chat input on /$org/$taskId.
 *
 * Drives a real browser end-to-end. Confirms:
 *   1. Empty thread renders the centered layout with Branch + Harness
 *      pills above the input and icebreakers below.
 *   2. Typing keeps the above-row visible.
 *   3. Submitting docks the input at the bottom; the above-row is gone;
 *      Branch + Harness render disabled inside the input bottom row;
 *      Model remains interactive.
 *   4. A non-clonable agent thread shows no above-row.
 *   5. The agent-shell header does NOT show a Branch pill anywhere.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";

const CHAT_INPUT = '[data-chat-input="true"]';
const CENTERED_WRAPPER = '[data-chat-centered="true"]';
const ABOVE_ROW = '[data-chat-above-row="true"]';
const DOCKED_INPUT = '[data-chat-docked-input="true"]';

const CHAT_INPUT_TIMEOUT_MS = 60_000;

async function waitForChatInput(page: Page): Promise<void> {
  await page
    .locator(CHAT_INPUT)
    .waitFor({ state: "visible", timeout: CHAT_INPUT_TIMEOUT_MS });
}

async function typeAndSend(page: Page, text: string): Promise<void> {
  const input = page.locator(CHAT_INPUT);
  await input.click();
  await page.keyboard.type(text);
  await expect(input).toHaveText(text, { timeout: 5_000 });
  await page.keyboard.press("Enter");
}

test.describe("centered chat input on /$org/$taskId", () => {
  test("clonable agent: empty → centered, submit → docked", async ({
    signedInPage,
    seedClonableThread,
  }) => {
    const { page, threadUrl } = await seedClonableThread(signedInPage);
    await page.goto(threadUrl);
    await waitForChatInput(page);

    // Empty state: centered wrapper + above-row + icebreakers visible.
    await expect(page.locator(CENTERED_WRAPPER)).toBeVisible();
    await expect(page.locator(ABOVE_ROW)).toBeVisible();

    // Above-row contains both BranchPill + ModePicker (Cloud / Claude
    // Code / Codex). They are gated by capability; for the seeded
    // clonable agent both must render.
    const aboveRow = page.locator(ABOVE_ROW);
    await expect(aboveRow.getByRole("button")).toHaveCount(2);

    // Type — above-row still visible.
    await page.locator(CHAT_INPUT).click();
    await page.keyboard.type("hello");
    await expect(page.locator(ABOVE_ROW)).toBeVisible();

    // Submit.
    await page.keyboard.press("Enter");

    // After submit: above-row gone, docked input mounted.
    await expect(page.locator(ABOVE_ROW)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(DOCKED_INPUT)).toBeVisible();

    // Branch + Harness now render inside the docked input bottom row,
    // disabled. The buttons are still present (so the user can SEE
    // their choice) but the popovers do not open.
    const dockedBranchOrMode = page
      .locator(DOCKED_INPUT)
      .locator('button[disabled], button[aria-disabled="true"]');
    // At least Branch + Harness should be disabled; Model is editable.
    await expect(dockedBranchOrMode).not.toHaveCount(0);
  });

  test("non-clonable agent: no above-row in empty state", async ({
    signedInPage,
    seedDecopilotThread,
  }) => {
    const { page, threadUrl } = await seedDecopilotThread(signedInPage);
    await page.goto(threadUrl);
    await waitForChatInput(page);

    await expect(page.locator(CENTERED_WRAPPER)).toBeVisible();
    await expect(page.locator(ABOVE_ROW)).toHaveCount(0);
  });

  test("agent-shell header does not render a Branch pill", async ({
    signedInPage,
    seedClonableThread,
  }) => {
    const { page, threadUrl } = await seedClonableThread(signedInPage);
    await page.goto(threadUrl);
    await waitForChatInput(page);

    // The legacy BranchPill in HeaderActions was rendered next to
    // "Save changes". Look for any visible branch-picker button outside
    // the chat input container.
    const headerBranch = page
      .locator("header, [data-toolbar]")
      .locator("button", { hasText: /^main|main$/ });
    await expect(headerBranch).toHaveCount(0);
  });
});
```

> **Fixture note:** `seedClonableThread` and `seedDecopilotThread` are illustrative names. The repo's e2e suite already exercises clonable agents (see `apps/mesh/e2e/tests/claude-code-title.spec.ts`) and a Decopilot agent (see `decopilot-messages.spec.ts`). Reuse whichever fixture pattern those tests use to mint a fresh empty thread URL. If no exact reusable fixture exists, copy the inline thread-creation block from `chat-input-draft.spec.ts` and adapt it for each agent type.

- [ ] **Step 3: Run the e2e test**

The e2e suite needs the dev server + DB. Follow the workflow already used by the project. From the repo root:

```bash
bun test apps/mesh/e2e/tests/centered-input.spec.ts
```

Expected: 3 tests pass. If the test fails, inspect screenshots/videos that Playwright writes on failure and adjust selectors. Common adjustments:
- `[data-chat-above-row="true"]` may be missing if Task 9 Step 1's edits didn't land — re-verify those edits.
- The "header has no Branch pill" assertion may need its selector tightened to whatever element wraps `HeaderActions` in the agent-shell layout.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/centered-composer.tsx \
        apps/mesh/src/web/components/chat/input.tsx \
        apps/mesh/e2e/tests/centered-input.spec.ts
git commit -m "test(chat): e2e for centered input + dock-on-submit"
```

---

## Task 10: Full pre-PR verification

**Files:** none (verification only).

- [ ] **Step 1: Run formatter**

Run: `bun run fmt`

Expected: no diffs (everything was committed already). If diffs appear, commit them with `chore: format`.

- [ ] **Step 2: Run linter**

Run: `bun run lint`

Expected: clean. Warnings on files you did not touch should be left alone; new warnings on files you did touch must be fixed.

- [ ] **Step 3: Run type check**

Run: `bun run check`

Expected: clean.

- [ ] **Step 4: Run the full unit test suite**

Run: `bun test`

Expected: clean (or, the same baseline of pre-existing failures as the `main` branch — verify by checking out `main` and running `bun test` once if anything fails on this branch and you suspect it's not yours).

- [ ] **Step 5: Run the new e2e test once more for sanity**

Run: `bun test apps/mesh/e2e/tests/centered-input.spec.ts`

Expected: pass.

- [ ] **Step 6: Take screenshots for the PR description**

With `bun run dev` running, capture three screenshots:

1. Clonable agent, empty thread — centered layout with both pills above.
2. Clonable agent, after first send — docked input with Branch + Harness disabled inside.
3. Non-clonable (Decopilot) empty thread — centered input, no above-row.

Save them somewhere local (don't commit images to git). They go into the PR body.

- [ ] **Step 7: Branch is ready for PR**

No final commit needed — every preceding task ended on a clean commit.

---

## Self-review checklist (already performed by the plan author)

**Spec coverage:**
- Q1 (BranchPill removal from header) → Task 8 ✓
- Q2 (home composer untouched) → no task; explicitly out of scope ✓
- Q3 (icebreakers below centered input) → Task 5 (`iceBreakers` slot below `input`) ✓
- Q4 (crossfade transition) → Task 7 (`animate-in fade-in-0 duration-200`) ✓
- Q5 (reuse existing pill style) → Tasks 2, 3 (no new pill variants) ✓
- Q6 (render only available pills) → Tasks 2, 3 (independent gates, returns `null` if both null) ✓
- Q7 (Model stays in bottom row) → Task 6 (only `ChatModeRow` is gated, `TierTrigger` is not) ✓
- Q8 (`messages.length === 0` gating, stays during compose) → Tasks 6, 7 (no draft-aware short-circuit) ✓

**Placeholder scan:** No "TBD", "TODO", "implement later", or vague "handle edge cases" steps. Every code block contains the actual code to write or paste.

**Type / name consistency:**
- `ChatModeRowPure` props: `branchPill` + `modePicker` (Tasks 1, 2, 3 — same names everywhere).
- `CenteredComposerPure` props: `readOnly`, `aboveRow`, `input`, `iceBreakers` (Tasks 4, 5 — same names).
- `data-*` attributes used in the e2e test (Task 9) are introduced in Task 9 Step 1, before the test that reads them.
- `setCurrentTaskBranch` is read via `useOptionalChatTask` in Task 3 and is the only writer for branch state — matches the spec's data-flow diagram.
