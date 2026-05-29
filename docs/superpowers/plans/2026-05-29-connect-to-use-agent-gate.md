# "Connect to use this agent" gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the current user is missing one or more of an agent's required (slotted) personal connections, replace the chat pane with a friendly "connect to use this agent" panel (with per-connection Connect links) instead of letting the run fail with a raw `SlotUnresolvedError`.

**Architecture:** Entirely client-side, no server change. A batched `useUnresolvedSlots` hook resolves every `slot_app_id` on the agent via the existing `CONNECTION_RESOLVE_FOR_USER` tool (one query, `Promise.all`) and returns the unresolved slots. `ChatPanelContent` early-returns a `ConnectAgentGate` panel (mirroring the existing `showProviderEmptyState` pattern: a `<Chat>` with `Chat.Main` and **no** `Chat.Footer`, so the composer is absent and no send is possible). A pure `unresolvedSlots` helper isolates the filter for unit testing.

**Tech Stack:** React 19, TanStack Query, TanStack Router, mesh-sdk hooks (`useVirtualMCP`, `useMCPClient`), Bun test, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-29-connect-to-use-agent-gate-design.md`

**Deviation from spec:** The spec described a *disabled* composer with a custom placeholder. This plan instead **omits the composer** while the gate is active (the panel + Connect links carry the action), matching the codebase's existing "agent can't run" pattern (`Chat.NoAiProviderEmptyState` in `side-panel-chat.tsx`). This avoids threading a custom placeholder through the Tiptap composer and is consistent with existing UX. The gate takes over the whole pane (it does not preserve prior messages); this is acceptable since an unresolved-slot agent is unusable and the empty-thread case is by far the common one.

---

## File Structure

- **Create** `apps/mesh/src/web/hooks/unresolved-slots.ts` — pure `unresolvedSlots` helper.
- **Create** `apps/mesh/src/web/hooks/unresolved-slots.test.ts` — unit tests.
- **Create** `apps/mesh/src/web/hooks/use-unresolved-slots.ts` — batched resolution hook.
- **Create** `apps/mesh/src/web/components/chat/connect-agent-gate.tsx` — the gate panel.
- **Modify** `apps/mesh/src/web/components/chat/side-panel-chat.tsx` — compute unresolved slots, early-return the gate.

---

## Task 1: `unresolvedSlots` pure helper

**Files:**
- Create: `apps/mesh/src/web/hooks/unresolved-slots.ts`
- Test: `apps/mesh/src/web/hooks/unresolved-slots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/web/hooks/unresolved-slots.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { unresolvedSlots } from "./unresolved-slots";

describe("unresolvedSlots", () => {
  it("returns [] when every slot resolves to a connection id", () => {
    const slots = [{ slot_app_id: "a" }, { slot_app_id: "b" }];
    expect(unresolvedSlots(slots, { a: "conn_1", b: "conn_2" })).toEqual([]);
  });

  it("returns slots whose app_id resolved to null", () => {
    const slots = [{ slot_app_id: "a" }, { slot_app_id: "b" }];
    expect(unresolvedSlots(slots, { a: "conn_1", b: null })).toEqual([
      { slot_app_id: "b" },
    ]);
  });

  it("treats an app_id missing from the map as unresolved", () => {
    const slots = [{ slot_app_id: "a" }, { slot_app_id: "b" }];
    expect(unresolvedSlots(slots, { a: "conn_1" })).toEqual([
      { slot_app_id: "b" },
    ]);
  });

  it("returns [] for an empty slot list", () => {
    expect(unresolvedSlots([], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/hooks/unresolved-slots.test.ts`
Expected: FAIL — `Cannot find module './unresolved-slots'`.

- [ ] **Step 3: Write the implementation**

Create `apps/mesh/src/web/hooks/unresolved-slots.ts`:

```typescript
/**
 * Given an agent's typed slots and a map of app_id -> resolved connection id
 * (null when the caller has no matching connection), returns the slots that did
 * NOT resolve — i.e. the connections the caller must connect before the agent
 * can run.
 */
export interface SlotLike {
  slot_app_id: string;
}

export function unresolvedSlots<T extends SlotLike>(
  slots: T[],
  resolvedByAppId: Record<string, string | null>,
): T[] {
  return slots.filter((slot) => !resolvedByAppId[slot.slot_app_id]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/web/hooks/unresolved-slots.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Format and commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add apps/mesh/src/web/hooks/unresolved-slots.ts apps/mesh/src/web/hooks/unresolved-slots.test.ts
git commit -m "feat(agents): add unresolvedSlots helper"
```

---

## Task 2: `useUnresolvedSlots` batched hook

**Files:**
- Create: `apps/mesh/src/web/hooks/use-unresolved-slots.ts`

This is a data hook (verified by type-check and downstream manual testing; the pure filter is already unit-tested in Task 1).

- [ ] **Step 1: Create the hook**

Create `apps/mesh/src/web/hooks/use-unresolved-slots.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import type { ResolvedConnectionForUser } from "./use-resolve-connection-for-user";
import { type SlotLike, unresolvedSlots } from "./unresolved-slots";

/**
 * Resolves every one of an agent's typed slots to the caller's own connection
 * in a single query (one CONNECTION_RESOLVE_FOR_USER call per app_id via
 * Promise.all), and returns the slots that don't resolve.
 *
 * Batched into one query on purpose: calling `useResolveConnectionForUser` once
 * per slot in a loop would change the hook count between renders and break the
 * rules of hooks.
 */
export function useUnresolvedSlots<T extends SlotLike>(
  orgId: string,
  orgSlug: string,
  slots: T[],
): { unresolved: T[]; isLoading: boolean } {
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
    orgSlug,
  });
  const appIds = slots.map((s) => s.slot_app_id);
  const sortedAppIds = [...appIds].sort();

  const query = useQuery({
    queryKey: ["unresolved-slots", orgId, ...sortedAppIds],
    enabled: appIds.length > 0,
    queryFn: async (): Promise<Record<string, string | null>> => {
      const entries = await Promise.all(
        appIds.map(async (appId) => {
          const result = await selfClient.callTool({
            name: "CONNECTION_RESOLVE_FOR_USER",
            arguments: { app_id: appId },
          });
          const structured = (result as { structuredContent?: unknown })
            .structuredContent;
          const text = (result as { content?: Array<{ text?: string }> })
            .content?.[0]?.text;
          const payload = (structured ??
            (text
              ? JSON.parse(text)
              : null)) as ResolvedConnectionForUser | null;
          return [appId, payload?.connectionId ?? null] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

  return {
    unresolved: query.data ? unresolvedSlots(slots, query.data) : [],
    isLoading: appIds.length > 0 && query.isLoading,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: exit 0. (If `ResolvedConnectionForUser` is not exported from `use-resolve-connection-for-user.ts`, it is — confirmed; the interface is exported there.)

- [ ] **Step 3: Format and commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add apps/mesh/src/web/hooks/use-unresolved-slots.ts
git commit -m "feat(agents): add useUnresolvedSlots batched resolution hook"
```

---

## Task 3: `ConnectAgentGate` component

**Files:**
- Create: `apps/mesh/src/web/components/chat/connect-agent-gate.tsx`

UI component (verified by type-check + manual; mirrors the existing `SidebarEmptyState` styling).

- [ ] **Step 1: Create the component**

Create `apps/mesh/src/web/components/chat/connect-agent-gate.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { Button } from "@deco/ui/components/button.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon";
import type { SlotLike } from "@/web/hooks/unresolved-slots";

/**
 * Shown in the chat pane when the current user is missing one or more of the
 * agent's required personal connections (typed slots). Lists each missing
 * connection with a Connect link to the Connections page. No composer is
 * rendered alongside this (the agent can't run until the slots are filled).
 */
export function ConnectAgentGate({
  agentTitle,
  agentIcon,
  slots,
  orgSlug,
}: {
  agentTitle: string;
  agentIcon: string | null;
  slots: SlotLike[];
  orgSlug: string;
}) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center justify-center gap-3 text-center max-w-md">
        <IntegrationIcon
          icon={agentIcon}
          name={agentTitle}
          size="lg"
          className="size-12 min-w-12 rounded-xl"
        />
        <h3 className="text-base md:text-xl font-medium text-foreground">
          Connect to use this agent
        </h3>
        <p className="text-muted-foreground text-sm">
          "{agentTitle}" needs your personal connections before it can run.
        </p>
      </div>
      <div className="w-full max-w-sm flex flex-col gap-2">
        {slots.map((slot) => (
          <div
            key={slot.slot_app_id}
            className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
          >
            <IntegrationIcon
              icon={null}
              name={slot.slot_app_id}
              size="sm"
              className="shrink-0"
            />
            <span className="flex-1 min-w-0 text-sm font-medium truncate">
              {slot.slot_app_id}
            </span>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-7 text-xs shrink-0"
            >
              <Link to="/$org/settings/connections" params={{ org: orgSlug }}>
                Connect
              </Link>
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: exit 0. If `IntegrationIcon` props differ, match its usage in `side-panel-chat.tsx` (it accepts `icon`, `name`, `size`, `className`).

- [ ] **Step 3: Format and commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add apps/mesh/src/web/components/chat/connect-agent-gate.tsx
git commit -m "feat(agents): add ConnectAgentGate panel"
```

---

## Task 4: Wire the gate into the chat panel

**Files:**
- Modify: `apps/mesh/src/web/components/chat/side-panel-chat.tsx`

- [ ] **Step 1: Add imports**

In `apps/mesh/src/web/components/chat/side-panel-chat.tsx`, add these imports (with the other local imports near the top):

```typescript
import { ConnectAgentGate } from "./connect-agent-gate";
import { useUnresolvedSlots } from "@/web/hooks/use-unresolved-slots";
```

- [ ] **Step 2: Compute unresolved slots in `ChatPanelContent`**

In `ChatPanelContent`, just after the existing line `const fullVm = useVirtualMCP(displayAgent.id);` (≈line 70), add:

```typescript
  const { unresolved, isLoading: slotsLoading } = useUnresolvedSlots(
    org.id,
    org.slug,
    fullVm?.slots ?? [],
  );
  const showConnectGate = !slotsLoading && unresolved.length > 0;
```

- [ ] **Step 3: Early-return the gate**

Immediately after the existing `showProviderEmptyState` `if (...) { return (...) }` block (the one rendering `<Chat.NoAiProviderEmptyState />`, ≈lines 81-91) and before the `showCreditsModal` computation, add:

```tsx
  if (showConnectGate) {
    return (
      <Chat className="animate-in fade-in-0 duration-200">
        <Chat.Main className="flex flex-col items-center">
          <ConnectAgentGate
            agentTitle={fullVm?.title ?? displayAgent.title}
            agentIcon={fullVm?.icon ?? displayAgent.icon}
            slots={unresolved}
            orgSlug={org.slug}
          />
        </Chat.Main>
      </Chat>
    );
  }
```

(This mirrors the `showProviderEmptyState` early return exactly — a `<Chat>` with only `Chat.Main`, no `Chat.Footer`, so no composer renders.)

- [ ] **Step 4: Type-check + lint**

Run:
```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run --cwd=apps/mesh check
bun run lint
```
Expected: `check` exit 0; `lint` 0 errors (pre-existing warnings in unrelated files are fine).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/side-panel-chat.tsx
git commit -m "feat(agents): gate chat on unresolved agent connections"
```

---

## Task 5: Verification

**Files:** none (verification only)

- [ ] **Step 1: Unit test + type-check + lint**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun test apps/mesh/src/web/hooks/unresolved-slots.test.ts
bun run --cwd=apps/mesh check
bun run lint
```
Expected: unit test PASS (4); `check` exit 0; lint 0 errors.

- [ ] **Step 2: Manual check (dev server)**

Start the app (`bun run dev`). As a user **without** the GitHub connection, open a GitHub-imported agent's chat. Confirm:
- The chat pane shows the "Connect to use this agent" panel listing the missing connection(s), each with a Connect button; no composer/input is shown.
- Clicking Connect navigates to the Connections page; after connecting and returning to the chat (refocus the window), the gate clears and the normal chat (composer) appears.
- As the agent **owner** (who has the GitHub connection), the gate does NOT appear — normal chat.
- An agent with **no slots** (e.g. the default Decopilot agent) shows the normal chat, never the gate.

---

## Follow-ups (out of scope)

- **Disabled composer instead of omitted** — if product prefers the composer visible-but-disabled (per the spec mockup), thread a `disabled` + custom placeholder through `Chat.Input` → `TiptapProvider` → `TiptapInput`. Omitted here to match the existing no-AI-provider pattern and avoid composer plumbing.
- **Preserve prior messages for non-empty threads** — current gate takes over the whole pane.
- **Pretty connection names** — rows show the raw `slot_app_id` (consistent with the slot card); a registry-title lookup is a later refinement.
- **Inline connect** — Connect deep-links out; no inline install flow.
