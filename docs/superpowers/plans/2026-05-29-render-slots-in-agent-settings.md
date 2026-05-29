# Render slotted connections in agent settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an agent's typed slots (e.g. the GitHub connection imported as a slot) in the settings "connections" section — violet-tinted with a "Slot" badge, resolved per-caller to the user's own connection, with a "not connected for you" state and remove action.

**Architecture:** A new `SlotItem` component resolves each `virtualMcp.slots[].slot_app_id` to the caller's connection via the existing `useResolveConnectionForUser` hook; resolved slots render like concrete connections (via `useConnection`), unresolved slots show a Connect deep-link. A pure `slotDisplayState` helper isolates the resolved/unresolved display decision. Slots are threaded through the agent form so removal persists. A new `special` (violet) `Badge` variant carries the visual distinction.

**Tech Stack:** React 19, TanStack Router + Query, react-hook-form, Zod, Tailwind v4 (design tokens), Bun test. Spec: `docs/superpowers/specs/2026-05-29-render-slots-in-agent-settings-design.md`.

**Scope note:** The ⚙ tool/resource-selection action on slot rows (from the spec) is **deferred to a follow-up** — it requires rewiring `DependencySelectionDialog` to key on `slot_app_id` and source tools from the resolved connection. New GitHub slots default to all-tools, so v1 ships render + remove + connect.

---

## File Structure

- **Modify** `packages/ui/src/components/badge.tsx` — add a `special` (violet) variant.
- **Create** `apps/mesh/src/web/views/virtual-mcp/slot-display.ts` — pure `slotDisplayState` helper.
- **Create** `apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts` — unit tests for the helper.
- **Create** `apps/mesh/src/web/views/virtual-mcp/slot-item.tsx` — the `SlotItem` component.
- **Modify** `apps/mesh/src/web/views/virtual-mcp/types.ts` — add `slots` to the form schema.
- **Modify** `apps/mesh/src/web/views/virtual-mcp/index.tsx` — render slots + `handleRemoveSlot`.

---

## Task 1: Add a `special` Badge variant

**Files:**
- Modify: `packages/ui/src/components/badge.tsx`

This is a styling-only constant (no logic to unit-test); it's verified by type-check and by its use in Task 4.

- [ ] **Step 1: Add the variant**

In `packages/ui/src/components/badge.tsx`, inside the `variant: { ... }` map of `badgeVariants`, add a `special` entry right after the `warning` entry:

```typescript
        warning:
          "border-transparent bg-warning text-warning-foreground [a&]:hover:bg-warning/90 focus-visible:ring-warning/20 dark:focus-visible:ring-warning/40",
        special:
          "border-transparent bg-special text-special-foreground [a&]:hover:bg-special/90 focus-visible:ring-special/20",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
```

(`--special` / `--color-special` tokens already exist in `packages/ui/src/styles/global.css`, so `bg-special` / `text-special-foreground` / `border-special` resolve.)

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=packages/ui check`
Expected: exits 0 (no type errors).

- [ ] **Step 3: Commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add packages/ui/src/components/badge.tsx
git commit -m "feat(ui): add special (violet) Badge variant"
```

---

## Task 2: `slotDisplayState` pure helper

**Files:**
- Create: `apps/mesh/src/web/views/virtual-mcp/slot-display.ts`
- Test: `apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { slotDisplayState } from "./slot-display";

describe("slotDisplayState", () => {
  it("uses the resolved connection's title and icon when resolved", () => {
    expect(
      slotDisplayState("deco/mcp-github", {
        title: "GitHub",
        icon: "https://example.com/gh.png",
      }),
    ).toEqual({
      state: "resolved",
      title: "GitHub",
      icon: "https://example.com/gh.png",
    });
  });

  it("falls back to the app_id with no icon when unresolved", () => {
    expect(slotDisplayState("deco/mcp-github", null)).toEqual({
      state: "unresolved",
      title: "deco/mcp-github",
      icon: null,
    });
  });

  it("preserves a null resolved icon", () => {
    expect(slotDisplayState("some/app", { title: "Some App", icon: null })).toEqual(
      { state: "resolved", title: "Some App", icon: null },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts`
Expected: FAIL — `Cannot find module './slot-display'`.

- [ ] **Step 3: Write the implementation**

Create `apps/mesh/src/web/views/virtual-mcp/slot-display.ts`:

```typescript
/**
 * Decides how to display a typed slot. A slot carries only a `slot_app_id`;
 * when it resolves to one of the caller's connections we show that connection's
 * title/icon, otherwise we fall back to the raw app_id (the "not connected for
 * you" state).
 */
export interface SlotDisplay {
  state: "resolved" | "unresolved";
  title: string;
  icon: string | null;
}

export function slotDisplayState(
  slotAppId: string,
  resolved: { title: string; icon: string | null } | null,
): SlotDisplay {
  if (resolved) {
    return { state: "resolved", title: resolved.title, icon: resolved.icon };
  }
  return { state: "unresolved", title: slotAppId, icon: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add apps/mesh/src/web/views/virtual-mcp/slot-display.ts apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts
git commit -m "feat(agents): add slotDisplayState helper for slot rendering"
```

---

## Task 3: Add `slots` to the agent form schema

**Files:**
- Modify: `apps/mesh/src/web/views/virtual-mcp/types.ts`

Without this, `VirtualMcpFormData` has no `slots` field, so `form.watch("slots")` / `form.setValue("slots", ...)` in later tasks are type errors and slot edits wouldn't persist.

- [ ] **Step 1: Add `slots` to the picked fields**

In `apps/mesh/src/web/views/virtual-mcp/types.ts`, add `slots: true` to the `.pick({...})` call:

```typescript
export const VirtualMcpFormSchema = VirtualMCPEntitySchema.pick({
  status: true,
  title: true,
  description: true,
  icon: true,
  metadata: true,
  connections: true,
  slots: true,
});
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: exits 0. (`VirtualMCPEntitySchema` already defines `slots`, so the pick is valid and `VirtualMcpFormData` now includes `slots: VirtualMCPSlot[]`.)

- [ ] **Step 3: Commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add apps/mesh/src/web/views/virtual-mcp/types.ts
git commit -m "feat(agents): include slots in the agent form schema"
```

---

## Task 4: `SlotItem` component

**Files:**
- Create: `apps/mesh/src/web/views/virtual-mcp/slot-item.tsx`

This is a UI component (rendering verified manually/E2E per the project's testing tiers; the pure decision is already unit-tested in Task 2).

- [ ] **Step 1: Create the component**

Create `apps/mesh/src/web/views/virtual-mcp/slot-item.tsx`:

```tsx
import { Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { XClose } from "@untitledui/icons";
import { useConnection } from "@decocms/mesh-sdk";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { getConnectionSlug } from "@/shared/utils/connection-slug";
import { useResolveConnectionForUser } from "@/web/hooks/use-resolve-connection-for-user";
import { slotDisplayState } from "./slot-display";

function SlotItemSkeleton() {
  return (
    <div className="rounded-xl border border-special/50 bg-special/5 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-8 rounded-md bg-muted animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="h-4 w-24 bg-muted rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}

/**
 * Renders one typed slot in the agent settings connections list. Resolves the
 * slot's app_id to the caller's own connection: resolved slots render like a
 * concrete connection (violet-tinted), unresolved slots show a Connect link.
 */
export function SlotItem({
  slotAppId,
  orgId,
  orgSlug,
  onRemove,
}: {
  slotAppId: string;
  orgId: string;
  orgSlug: string;
  onRemove: () => void;
}) {
  const resolveQuery = useResolveConnectionForUser(orgId, orgSlug, slotAppId);
  if (resolveQuery.isLoading) return <SlotItemSkeleton />;
  const resolvedId = resolveQuery.data?.connectionId ?? null;
  return (
    <Suspense fallback={<SlotItemSkeleton />}>
      <SlotItemInner
        slotAppId={slotAppId}
        resolvedId={resolvedId}
        orgSlug={orgSlug}
        onRemove={onRemove}
      />
    </Suspense>
  );
}

function SlotItemInner({
  slotAppId,
  resolvedId,
  orgSlug,
  onRemove,
}: {
  slotAppId: string;
  resolvedId: string | null;
  orgSlug: string;
  onRemove: () => void;
}) {
  // useConnection tolerates undefined (returns null without suspending); when a
  // resolvedId is present it suspends until loaded (caught by the parent).
  const connection = useConnection(resolvedId ?? undefined);
  const resolved =
    resolvedId && connection
      ? { title: connection.title, icon: connection.icon }
      : null;
  const display = slotDisplayState(slotAppId, resolved);
  const detailSlug = connection ? getConnectionSlug(connection) : null;
  const isResolved = display.state === "resolved" && detailSlug !== null;

  return (
    <div className="rounded-xl border border-special/50 bg-special/5 overflow-hidden transition-colors">
      {isResolved ? (
        <Link
          to="/$org/settings/connections/$appSlug"
          params={{ org: orgSlug, appSlug: detailSlug! }}
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors"
        >
          <IntegrationIcon
            icon={display.icon}
            name={display.title}
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{display.title}</p>
            <p className="text-xs text-muted-foreground truncate">
              Resolves to your connection
            </p>
          </div>
          <Badge variant="special" className="shrink-0">
            Slot
          </Badge>
        </Link>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3">
          <IntegrationIcon
            icon={display.icon}
            name={display.title}
            size="sm"
            className="shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{display.title}</p>
            <p className="text-xs text-muted-foreground truncate">
              Not connected for you
            </p>
          </div>
          <Badge variant="special" className="shrink-0">
            Slot
          </Badge>
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
      )}

      <div className="flex items-center gap-3 px-4 py-2 border-t border-special/30 bg-special/5">
        <div className="flex items-center gap-0.5 ml-auto">
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={onRemove}
                aria-label="Remove slot"
              >
                <XClose size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Remove</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd=apps/mesh check`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run fmt
git add apps/mesh/src/web/views/virtual-mcp/slot-item.tsx
git commit -m "feat(agents): add SlotItem component for rendering typed slots"
```

---

## Task 5: Render slots in the settings connections section

**Files:**
- Modify: `apps/mesh/src/web/views/virtual-mcp/index.tsx`

- [ ] **Step 1: Import `SlotItem`**

In `apps/mesh/src/web/views/virtual-mcp/index.tsx`, add this import next to the other local `./` imports (e.g. right after the `getConnectionSlug` import at line 19, or with the view's sibling imports):

```typescript
import { SlotItem } from "./slot-item";
```

- [ ] **Step 2: Watch slots + add the remove handler**

Just after the existing `const connections = form.watch("connections");` (≈line 1164), add:

```typescript
  const slots = form.watch("slots") ?? [];
```

And add a `handleRemoveSlot` near `handleRemoveConnection` (≈line 1363), after that function's closing brace:

```typescript
  const handleRemoveSlot = (slotAppId: string) => {
    const current = form.getValues("slots") ?? [];
    form.setValue(
      "slots",
      current.filter((s) => s.slot_app_id !== slotAppId),
      { shouldDirty: true },
    );
  };
```

- [ ] **Step 3: Render slots and fix the empty-state condition**

In the Connections `<section>` (≈line 1760), replace the list `<div className="flex flex-col gap-2"> ... </div>` block so the empty state checks both lists and slots render after concrete connections. Replace:

```tsx
              <div className="flex flex-col gap-2">
                {connections.length === 0 ? (
```

with:

```tsx
              <div className="flex flex-col gap-2">
                {connections.length === 0 && slots.length === 0 ? (
```

Then, immediately after the `connections.map(...)` `)` and before the closing `)}` of the ternary's else branch (i.e. right after the `</ErrorBoundary>` + `))` that ends the connections map, still inside the same `<div className="flex flex-col gap-2">`), add the slots map. The end of the connections map currently looks like:

```tsx
                  connections.map((conn) => (
                    <ErrorBoundary
                      key={conn.connection_id}
                      fallback={() => null}
                    >
                      <Suspense fallback={<ConnectionItemSkeleton />}>
                        <ConnectionItem
                          connection_id={conn.connection_id}
                          usedConnectionIds={addedConnectionIds}
                          onOpenSettings={() =>
                            handleOpenSettings(conn.connection_id)
                          }
                          onRemove={() =>
                            handleRemoveConnection(conn.connection_id)
                          }
                          onAuthenticate={handleAuthenticate}
                          onSwitchInstance={handleSwitchInstance}
                          onNewInstance={() =>
                            handleNewInstance(conn.connection_id)
                          }
                        />
                      </Suspense>
                    </ErrorBoundary>
                  ))
                )}
              </div>
```

Change the trailing `))` + `)}` so the slots render alongside. Replace that exact tail:

```tsx
                  ))
                )}
              </div>
```

with:

```tsx
                  ))
                )}
                {slots.map((slot) => (
                  <ErrorBoundary
                    key={`slot:${slot.slot_app_id}`}
                    fallback={() => null}
                  >
                    <SlotItem
                      slotAppId={slot.slot_app_id}
                      orgId={org.id}
                      orgSlug={org.slug}
                      onRemove={() => handleRemoveSlot(slot.slot_app_id)}
                    />
                  </ErrorBoundary>
                ))}
              </div>
```

(`org` is already in scope in this component via `useProjectContext`/the existing `org` binding used elsewhere in the file, e.g. `org.slug` in handlers.)

- [ ] **Step 4: Type-check + lint**

Run:
```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run --cwd=apps/mesh check
bun run lint
```
Expected: `check` exits 0; `lint` reports 0 errors (pre-existing warnings unrelated to these files are acceptable).

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/views/virtual-mcp/index.tsx
git commit -m "feat(agents): render typed slots in agent settings connections"
```

---

## Task 6: Verification

**Files:** none (verification only)

- [ ] **Step 1: Run the unit test + type-check + lint**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun test apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts
bun run --cwd=apps/mesh check
bun run --cwd=packages/ui check
bun run lint
```
Expected: unit test PASS; both `check`s exit 0; lint 0 errors.

- [ ] **Step 2: Manual check (dev server)**

Start the app (`bun run dev`), open a GitHub-imported agent's settings (`...?virtualmcpid=vir_...&main=settings`), and confirm:
- The GitHub slot now appears in the Connections section, violet-tinted with a "Slot" badge and "Resolves to your connection".
- The ✕ removes it and the change persists across reload (the slot is gone).
- Concrete connections on the same agent are unaffected by removing/keeping the slot.
- (If testable) a second org member viewing the same agent sees the violet "Not connected for you" card with a Connect button.

---

## Deferred (follow-up, not in this plan)

- **⚙ tool/resource selection for slots** — requires `DependencySelectionDialog` to accept a slot keyed by `slot_app_id`, source the available tool list from the resolved connection, and persist the selection into the slot's `selected_*` fields. New GitHub slots default to all-tools, so this is not blocking. Spec lists it; pull into its own plan when prioritized.
