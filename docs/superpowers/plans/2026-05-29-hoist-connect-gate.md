# Hoist the connect gate to the whole agent view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "connect to use this agent" gate from the chat panel up to the agent-view container (`AgentInsetProvider`), so that an agent with unresolved slots walls its entire view (tab bar + all tabs + chat) for the current user (owner included), and remove the now-redundant chat-panel gate and the settings-tab slot Connect button.

**Architecture:** `AgentInsetProvider` already fetches `entity = useVirtualMCP(id)` and has `org`. Add a `useUnresolvedSlots` call and an early return that renders the existing `ConnectAgentGate` filling the inset (before the desktop/mobile layout split, covering both). Remove the duplicate gate from `ChatPanelContent`. Simplify `SlotItem`'s unresolved branch (drop the Connect button) since settings is now only reachable when all slots resolve.

**Tech Stack:** React 19, TanStack Router/Query, mesh-sdk hooks, Tailwind v4, Bun.

**Spec:** `docs/superpowers/specs/2026-05-29-hoist-connect-gate-design.md`

---

## File Structure

- **Modify** `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx` — compute unresolved slots, early-return the gate.
- **Modify** `apps/mesh/src/web/components/chat/side-panel-chat.tsx` — remove the chat-panel gate.
- **Modify** `apps/mesh/src/web/views/virtual-mcp/slot-item.tsx` — drop the unresolved Connect button.

No new files; reuses `ConnectAgentGate` and `useUnresolvedSlots`. No new unit tests (the `unresolvedSlots` logic is unchanged and already covered); UI verified by type-check + manual.

---

## Task 1: Gate the whole agent view in `AgentInsetProvider`

**Files:**
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`

- [ ] **Step 1: Add imports**

Add these imports alongside the existing imports in `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`:

```typescript
import { ConnectAgentGate } from "@/web/components/chat/connect-agent-gate";
import { useUnresolvedSlots } from "@/web/hooks/use-unresolved-slots";
```

- [ ] **Step 2: Compute unresolved slots (unconditional hook, before any return)**

In `AgentInsetProvider`, immediately after the existing line `const entity = useVirtualMCP(virtualMcpId);` (≈line 310), add:

```typescript
  const { unresolved, isLoading: slotsLoading } = useUnresolvedSlots(
    org.id,
    org.slug,
    entity?.slots ?? [],
  );
  const showConnectGate = !slotsLoading && unresolved.length > 0;
```

(`org` is in scope via `useProjectContext()`. This hook is added before all early returns, so hook order stays stable.)

- [ ] **Step 3: Early-return the gate**

In `AgentInsetProvider`, immediately AFTER the `const insetContextValue: InsetContextValue = { virtualMcpId, entity };` declaration (≈line 350) and BEFORE the existing `if (ensureState.status === "creating" || ...)` return, insert:

```tsx
  if (showConnectGate) {
    return (
      <InsetContext value={insetContextValue}>
        <div className="flex-1 min-w-0 flex flex-col">
          <ConnectAgentGate
            agentTitle={entity?.title ?? ""}
            agentIcon={entity?.icon ?? null}
            slots={unresolved}
            orgSlug={org.slug}
          />
        </div>
      </InsetContext>
    );
  }
```

This sits before the desktop/mobile layout split, so it walls both. `InsetContext` is already imported (used by the sibling `ensureState` return). `ConnectAgentGate` centers itself (`h-full w-full flex items-center justify-center`).

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
git add apps/mesh/src/web/layouts/agent-shell-layout/index.tsx
git commit -m "feat(agents): gate the whole agent view on unresolved connections"
```

---

## Task 2: Remove the redundant chat-panel gate

**Files:**
- Modify: `apps/mesh/src/web/components/chat/side-panel-chat.tsx`

- [ ] **Step 1: Remove the gate imports**

In `apps/mesh/src/web/components/chat/side-panel-chat.tsx`, delete these two import lines (≈lines 24-25):

```typescript
import { ConnectAgentGate } from "./connect-agent-gate";
import { useUnresolvedSlots } from "@/web/hooks/use-unresolved-slots";
```

- [ ] **Step 2: Remove the hook call + `showConnectGate`**

In `ChatPanelContent`, delete this block (≈lines 73-78), which currently sits between `const fullVm = useVirtualMCP(displayAgent.id);` and `const link = useCurrentLink();`:

```typescript
  const { unresolved, isLoading: slotsLoading } = useUnresolvedSlots(
    org.id,
    org.slug,
    fullVm?.slots ?? [],
  );
  const showConnectGate = !slotsLoading && unresolved.length > 0;
```

(Leave `const fullVm = useVirtualMCP(displayAgent.id);` — it's still used by `isClonableAgent = agentHasClonableSource(fullVm?.metadata)` below.)

- [ ] **Step 3: Remove the gate early return**

Delete this block (≈lines 101-114), which sits between the `showProviderEmptyState` return and the `showCreditsModal` comment:

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

- [ ] **Step 4: Type-check + lint**

Run:
```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run --cwd=apps/mesh check
bun run lint
```
Expected: `check` exit 0 (no unused-import or undefined-symbol errors); `lint` 0 errors.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/side-panel-chat.tsx
git commit -m "refactor(agents): drop chat-panel connect gate in favor of the view-level gate"
```

---

## Task 3: Drop the Connect button from `SlotItem`'s unresolved branch

**Files:**
- Modify: `apps/mesh/src/web/views/virtual-mcp/slot-item.tsx`

- [ ] **Step 1: Remove the Connect button**

In `apps/mesh/src/web/views/virtual-mcp/slot-item.tsx`, in the unresolved branch (the `: (` branch of `isResolved`), delete the Connect button block so the row keeps only the icon + title + "Not connected for you" text. Replace:

```tsx
            <p className="text-xs text-muted-foreground truncate">
              Not connected for you
            </p>
          </div>
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
```

with:

```tsx
            <p className="text-xs text-muted-foreground truncate">
              Not connected for you
            </p>
          </div>
        </div>
      )}
```

(`Button` is still used by the footer's Remove control and `Link` by the resolved branch's card link, so no imports are removed.)

- [ ] **Step 2: Type-check + lint**

Run:
```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun run --cwd=apps/mesh check
bun run lint
```
Expected: `check` exit 0 (no unused-import errors for `Button`/`Link` — both still used); `lint` 0 errors.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/views/virtual-mcp/slot-item.tsx
git commit -m "refactor(agents): remove Connect button from settings slot rows"
```

---

## Task 4: Verification

**Files:** none (verification only)

- [ ] **Step 1: Unit test (unchanged logic) + type-check + lint**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/stuttgart-v3
bun test apps/mesh/src/web/hooks/unresolved-slots.test.ts
bun run --cwd=apps/mesh check
bun run lint
```
Expected: unit test PASS (4); `check` exit 0; `lint` 0 errors.

- [ ] **Step 2: Manual check (dev server)**

Start the app (`bun run dev`). As a user **without** the agent's required connection:
- Open a GitHub-imported agent at `?virtualmcpid=...&main=settings` (and `main=preview`, `main=automations`, and the chat) → in every case the entire agent view is replaced by the connect gate (no tab bar, no chat). Click Connect → Connections page; connect and return → the gate clears (refetch-on-focus) and the normal view appears.
- As a user **with** the connection (or the agent owner who has it): the agent view renders normally; the settings tab shows the slot(s) with the violet "Personal" chip and **no** Connect button.
- A slotless agent (e.g. the default Decopilot agent) is never gated.

---

## Out of scope (future)

- Inline/in-place connect inside the gate (still deep-links to Connections).
- Moving `ConnectAgentGate` out of `components/chat/` now that chat no longer owns it.
