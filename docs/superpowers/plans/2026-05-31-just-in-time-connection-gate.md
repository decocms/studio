# Just-in-Time Connection Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the upfront composer gate with one runtime mechanism: when an agent (parent) or a delegated subagent can't resolve all its typed slots for the invoking user, the run emits a structured `data-connect-required` chunk that the chat renders as a single connect card (Connect buttons + Retry).

**Architecture:** Both the parent and subagent assemble their MCP client through the same `createVirtualClientFrom`, which already throws `SlotUnresolvedError`. We (1) make that error collect *all* missing app_ids and carry the agent identity, (2) catch it at the two boundaries (`assembleDecopilotTools` for the parent, `subtask.ts` for the subagent) and emit one typed stream chunk, (3) render that chunk as a visible `ConnectCard` reusing the existing `ConnectSlotRow`, and (4) delete the now-redundant upfront gate.

**Tech Stack:** TypeScript, Bun test, Hono server, React 19 (Vite), AI SDK `UIMessageStreamWriter` data chunks, Kysely/Postgres.

**Spec:** `docs/superpowers/specs/2026-05-31-just-in-time-connection-gate-design.md`

---

## File structure

**Server (modify):**
- `apps/mesh/src/core/slot-resolver.ts` — `SlotUnresolvedError` carries `appIds[] + agentId + agentTitle`.
- `apps/mesh/src/mcp-clients/virtual-mcp/index.ts` — slot loop collects all unresolved, throws once.
- `apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.ts` — catch + emit chunk + model text (subagent boundary).
- `apps/mesh/src/harnesses/decopilot/index.ts` — catch + emit chunk + return (parent boundary).
- `apps/mesh/src/api/routes/decopilot/types.ts` — register the `connect-required` data part.

**Frontend (create/modify):**
- `apps/mesh/src/web/components/chat/connect-card.tsx` — NEW visible card (reuses `ConnectSlotRow`).
- `apps/mesh/src/web/components/chat/message/use-filter-parts.ts` — let `data-connect-required` reach renderOrder.
- `apps/mesh/src/web/components/chat/message/assistant.tsx` — render the card for the new part.
- `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx` — remove the upfront gate.

**Frontend (delete — dead after gate removal):**
- `apps/mesh/src/web/components/chat/connect-agent-gate.tsx`
- `apps/mesh/src/web/hooks/use-unresolved-slots.ts`
- `apps/mesh/src/web/hooks/unresolved-slots.ts`
- `apps/mesh/src/web/hooks/unresolved-slots.test.ts`

**Keep (now consumed by `ConnectCard`):** `connect-slot-row.tsx`, `use-slot-app-displays.ts`.

**Tests:**
- `apps/mesh/src/core/slot-resolver.test.ts` (modify) — new error shape.
- `apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver.integration.test.ts` (modify) — `.appIds` assertion.

---

## Task 1: Restructure `SlotUnresolvedError` to carry all app_ids + agent identity

**Files:**
- Modify: `apps/mesh/src/core/slot-resolver.ts:36-45`
- Test: `apps/mesh/src/core/slot-resolver.test.ts:70-77`

- [ ] **Step 1: Update the failing unit test first**

Replace the existing `describe("SlotUnresolvedError", …)` block (lines 70-77) with:

```ts
describe("SlotUnresolvedError", () => {
  it("carries all app_ids and agent identity for the UI to surface", () => {
    const err = new SlotUnresolvedError(
      ["mcp-github", "google-gmail"],
      "vmcp_123",
      "My Agent",
    );
    expect(err.appIds).toEqual(["mcp-github", "google-gmail"]);
    expect(err.agentId).toBe("vmcp_123");
    expect(err.agentTitle).toBe("My Agent");
    expect(err.name).toBe("SlotUnresolvedError");
    expect(err.message).toContain("mcp-github");
    expect(err.message).toContain("google-gmail");
    expect(err.message).toContain("My Agent");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/core/slot-resolver.test.ts`
Expected: FAIL — `SlotUnresolvedError` constructor still takes a single string; `.appIds`/`.agentId`/`.agentTitle` undefined.

- [ ] **Step 3: Rewrite the class**

Replace lines 36-45 of `slot-resolver.ts` with:

```ts
export class SlotUnresolvedError extends Error {
  readonly appIds: string[];
  readonly agentId: string;
  readonly agentTitle: string;
  constructor(appIds: string[], agentId: string, agentTitle: string) {
    super(
      `Agent '${agentTitle}' (${agentId}) has unresolved slots for app_ids: ${appIds.join(", ")} — the caller has no matching connection.`,
    );
    this.name = "SlotUnresolvedError";
    this.appIds = appIds;
    this.agentId = agentId;
    this.agentTitle = agentTitle;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/core/slot-resolver.test.ts`
Expected: PASS. (Note: `apps/mesh/src/mcp-clients/virtual-mcp/index.ts` will now have type errors at its 3 throw sites — fixed in Task 2. Do NOT run `bun run check` yet.)

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/core/slot-resolver.ts apps/mesh/src/core/slot-resolver.test.ts
git commit -m "refactor(slots): SlotUnresolvedError carries all app_ids + agent identity"
```

---

## Task 2: Collect all unresolved slots in `createVirtualClientFrom` (throw once)

**Files:**
- Modify: `apps/mesh/src/mcp-clients/virtual-mcp/index.ts:149-211`
- Test: `apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver.integration.test.ts:199-200`

The current loop throws on the first unresolved slot. Change it to accumulate every unresolved `app_id` and throw once after the loop, so the card lists all missing apps. Preserve the single `SlotResolutionCache` instance and the resolved-connection aggregation for the slots that DO resolve.

- [ ] **Step 1: Replace the slot-resolution loop**

Current code (index.ts:149-211) — the `if (virtualMcp.slots.length > 0) { … }` block. Replace its body with:

```ts
  if (virtualMcp.slots.length > 0) {
    const invokerUserId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    const slotCache = new SlotResolutionCache();
    const activeSpan = trace.getActiveSpan();
    const unresolvedAppIds: string[] = [];

    for (const slot of virtualMcp.slots) {
      if (!invokerUserId) {
        unresolvedAppIds.push(slot.slot_app_id);
        continue;
      }

      const resolved = await slotCache.resolve(
        invokerUserId,
        slot.slot_app_id,
        () =>
          resolveSlot(ctx.db, {
            organizationId: virtualMcp.organization_id,
            invokerUserId,
            appId: slot.slot_app_id,
          }),
      );
      if (!resolved) {
        unresolvedAppIds.push(slot.slot_app_id);
        continue;
      }

      // Slot resolver already enforces per-user access by looking up the
      // invoker's own slot row; once resolved, the connection lookup itself
      // is just an entity hydration step, so INTERNAL_VIEWER is appropriate.
      const resolvedEntity = await ctx.storage.connections.findById(
        resolved.connectionId,
        virtualMcp.organization_id,
        INTERNAL_VIEWER,
      );
      if (!resolvedEntity) {
        // Defensive: resolver pointed at a row that disappeared (e.g.
        // deleted between the resolveSlot SELECT and this findById). Treat
        // as unresolved so the UI prompts the user to reconnect.
        unresolvedAppIds.push(slot.slot_app_id);
        continue;
      }

      resolvedConnections.push(resolvedEntity);
      resolvedVMCPConnections.push({
        connection_id: resolved.connectionId,
        selected_tools: slot.selected_tools,
        selected_resources: slot.selected_resources,
        selected_prompts: slot.selected_prompts,
      });

      if (activeSpan) {
        activeSpan.setAttribute(
          `slot.${slot.slot_app_id}.app_id`,
          slot.slot_app_id,
        );
        activeSpan.setAttribute(
          `slot.${slot.slot_app_id}.connection_id`,
          resolved.connectionId,
        );
        activeSpan.setAttribute(
          `slot.${slot.slot_app_id}.access`,
          resolved.access,
        );
      }
    }

    if (unresolvedAppIds.length > 0) {
      // De-dupe in case two slots reference the same app_id.
      const uniqueAppIds = [...new Set(unresolvedAppIds)];
      throw new SlotUnresolvedError(
        uniqueAppIds,
        virtualMcp.id ?? "",
        virtualMcp.title,
      );
    }
  }
```

- [ ] **Step 2: Update the integration test assertion**

In `apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver.integration.test.ts`, find lines 199-200:

```ts
    expect(caught).toBeInstanceOf(SlotUnresolvedError);
    expect((caught as SlotUnresolvedError).appId).toBe("mcp-github");
```

Replace with:

```ts
    expect(caught).toBeInstanceOf(SlotUnresolvedError);
    expect((caught as SlotUnresolvedError).appIds).toContain("mcp-github");
```

- [ ] **Step 3: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS (the 3 former throw sites are gone; the single throw uses the new signature).

- [ ] **Step 4: Run the unit test suite for the resolver**

Run: `bun test apps/mesh/src/core/slot-resolver.test.ts`
Expected: PASS. (The integration test requires the Docker DB harness per TESTING.md; if available run `bun test apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver.integration.test.ts`, otherwise note it for the e2e pass in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/mcp-clients/virtual-mcp/index.ts apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver.integration.test.ts
git commit -m "feat(slots): collect all unresolved slots and throw once"
```

---

## Task 3: Register the `connect-required` data part type

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/types.ts:26-55`

The `ChatMessage` type's second generic is the data-parts map. Each key `K` becomes the runtime part type `data-K`. Add a `connect-required` entry so both server `writer.write` and the frontend switch are typed.

- [ ] **Step 1: Add the data-part entry**

In the `ChatMessage` data-parts object (the second generic argument), add this key alongside `"thread-title"`:

```ts
    "connect-required": {
      agentId: string;
      agentTitle: string;
      appIds: string[];
    };
```

- [ ] **Step 2: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/api/routes/decopilot/types.ts
git commit -m "feat(chat): register data-connect-required part type"
```

---

## Task 4: Subagent boundary — catch in `subtask.ts`, emit chunk + model text

**Files:**
- Modify: `apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.ts:13-15,96-101,188-190`

`createVirtualClientFrom` (line 97) sits OUTSIDE the existing `try { … } finally { mcpClient.close() }` (lines 103-190). Wrap it in its own try/catch so a `SlotUnresolvedError` emits the chunk and yields a model-facing result instead of crashing the tool.

- [ ] **Step 1: Add the import**

Add near the other imports (after line 13):

```ts
import { SlotUnresolvedError } from "@/core/slot-resolver";
```

- [ ] **Step 2: Wrap `createVirtualClientFrom` (current lines 96-101)**

Current:

```ts
      // 2. Create MCP client for the target.
      const mcpClient = await createVirtualClientFrom(
        virtualMcp,
        ctx,
        "passthrough",
      );

      try {
```

Replace with:

```ts
      // 2. Create MCP client for the target. If the target agent has typed
      //    slots the invoking user hasn't connected, createVirtualClientFrom
      //    throws SlotUnresolvedError — surface it as a connect card to the
      //    user (data chunk) and a clear instruction to the model, instead of
      //    a generic "tool failed".
      let mcpClient: Awaited<ReturnType<typeof createVirtualClientFrom>>;
      try {
        mcpClient = await createVirtualClientFrom(virtualMcp, ctx, "passthrough");
      } catch (err) {
        if (err instanceof SlotUnresolvedError) {
          writer.write({
            type: "data-connect-required",
            id: toolCallId,
            data: {
              agentId: err.agentId,
              agentTitle: err.agentTitle,
              appIds: err.appIds,
            },
          });
          yield {
            text: "",
            error: `Cannot run subagent "${err.agentTitle}": the user must connect ${err.appIds.join(", ")}. A connect card was shown — ask the user to connect, then retry.`,
            finishReason: "stop",
          };
          return;
        }
        throw err;
      }

      try {
```

- [ ] **Step 3: Make the `finally` null-safe**

The closing `finally` (current line 188-190) references `mcpClient`. It is now always assigned before the inner `try`, so it is unchanged:

```ts
      } finally {
        mcpClient.close().catch(() => {});
      }
```

Leave it as-is (no change needed — `mcpClient` is guaranteed assigned when the inner `try` is entered).

- [ ] **Step 4: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS.

- [ ] **Step 5: Run the subtask unit test**

Run: `bun test apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.test.ts`
Expected: PASS (existing behavior unchanged for the happy path).

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.ts
git commit -m "feat(subtask): emit connect-required card when a subagent slot is unresolved"
```

---

## Task 5: Parent boundary — catch in `index.ts`, emit chunk + end run

**Files:**
- Modify: `apps/mesh/src/harnesses/decopilot/index.ts` (imports + lines 167-176)

The parent's tools (and its `createVirtualClientFrom`) are assembled by `assembleDecopilotTools` at `index.ts:167`, where `pl.writer` is in scope. A `SlotUnresolvedError` here means the parent's own slots are unresolved (previously caught by the upfront gate). Catch it, emit the same chunk, and `return` to end the run cleanly.

- [ ] **Step 1: Add the import**

Add to the imports at the top of `index.ts`:

```ts
import { SlotUnresolvedError } from "@/core/slot-resolver";
```

- [ ] **Step 2: Wrap `assembleDecopilotTools` (current lines 167-176)**

Current:

```ts
        const tools = await assembleDecopilotTools(effectiveInput, ctx, {
          writer: pl.writer,
          toolOutputMap: pl.toolOutputMap,
          pendingImages: pl.pendingImages,
          threadId: pl.threadId,
          provider: pl.provider,
          imageProvider: pl.imageProvider ?? pl.provider,
          deepResearchProvider: pl.deepResearchProvider ?? pl.provider,
          htmlPageBuffer: pl.htmlPageBuffer,
        });
```

Replace with:

```ts
        let tools: Awaited<ReturnType<typeof assembleDecopilotTools>>;
        try {
          tools = await assembleDecopilotTools(effectiveInput, ctx, {
            writer: pl.writer,
            toolOutputMap: pl.toolOutputMap,
            pendingImages: pl.pendingImages,
            threadId: pl.threadId,
            provider: pl.provider,
            imageProvider: pl.imageProvider ?? pl.provider,
            deepResearchProvider: pl.deepResearchProvider ?? pl.provider,
            htmlPageBuffer: pl.htmlPageBuffer,
          });
        } catch (err) {
          if (err instanceof SlotUnresolvedError) {
            // The parent agent's own slots are unresolved for this user.
            // Surface the connect card and end the run cleanly (no model
            // call happens) instead of a generic stream error.
            pl.writer.write({
              type: "data-connect-required",
              data: {
                agentId: err.agentId,
                agentTitle: err.agentTitle,
                appIds: err.appIds,
              },
            });
            return;
          }
          throw err;
        }
```

The existing `try { … } finally { await tools.close().catch(() => {}); }` block (current lines 178-231) continues unchanged and now refers to the `tools` declared above.

- [ ] **Step 3: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/harnesses/decopilot/index.ts
git commit -m "feat(harness): emit connect-required card when the parent agent's slots are unresolved"
```

---

## Task 6: Let `data-connect-required` reach the render order (frontend)

**Files:**
- Modify: `apps/mesh/src/web/components/chat/message/use-filter-parts.ts` (the renderOrder skip, ~line 176)

All `data-*` parts are normally skipped from `renderOrder` (so they never render). `data-connect-required` is a *visible* card, so it must pass through. Do NOT add an extraction handler for it (it is not keyed metadata).

- [ ] **Step 1: Find the renderOrder skip**

Search for the line that skips data parts:

Run: `rg -n 'startsWith\("data-"\)' apps/mesh/src/web/components/chat/message/use-filter-parts.ts`
Expected: a line like `if (p.type.startsWith("data-")) continue;`

- [ ] **Step 2: Add the exception**

Change that line to keep `data-connect-required` visible:

```ts
      // data-* parts are metadata side-channels and never render — EXCEPT
      // data-connect-required, which is a visible connect card.
      if (p.type.startsWith("data-") && p.type !== "data-connect-required") {
        continue;
      }
```

- [ ] **Step 3: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/components/chat/message/use-filter-parts.ts
git commit -m "feat(chat): keep data-connect-required parts in render order"
```

---

## Task 7: Create the `ConnectCard` component (frontend)

**Files:**
- Create: `apps/mesh/src/web/components/chat/connect-card.tsx`

Reuses `ConnectSlotRow` + `useSlotAppDisplays` (the same building blocks the old gate used) and adds a Retry button that re-runs the last user turn.

- [ ] **Step 1: Confirm the chat-stream hook name and shape**

Run: `rg -n 'export function useChatStream|sendMessage:' apps/mesh/src/web/components/chat/chat-context.tsx`
Expected: a `useChatStream` (or similarly named) hook exposing `sendMessage` and `messages`. Use whatever the exact exported name is in Step 2's import.

- [ ] **Step 2: Write the component**

```tsx
import { Suspense } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { ConnectSlotRow } from "@/web/components/chat/connect-slot-row";
import { useChatStream } from "@/web/components/chat/chat-context";
import { useSlotAppDisplays } from "@/web/hooks/use-slot-app-displays";

interface ConnectCardData {
  agentId: string;
  agentTitle: string;
  appIds: string[];
}

/**
 * Visible connect card rendered inline in the assistant message when an agent
 * (parent or a delegated subagent) couldn't resolve its typed slots for the
 * current user. Shows one Connect row per missing app and a Retry button that
 * re-runs the last user turn once the connections are in place.
 */
export function ConnectCard({ data }: { data: ConnectCardData }) {
  return (
    <Suspense fallback={<ConnectCardFallback data={data} />}>
      <ConnectCardInner data={data} />
    </Suspense>
  );
}

function ConnectCardFallback({ data }: { data: ConnectCardData }) {
  return (
    <div className="rounded-xl border border-border p-4 my-1.5">
      <p className="text-sm font-medium">
        Connect to use “{data.agentTitle}”
      </p>
      <p className="text-xs text-muted-foreground">Loading connections…</p>
    </div>
  );
}

function ConnectCardInner({ data }: { data: ConnectCardData }) {
  const { org } = useProjectContext();
  const { sendMessage, messages } = useChatStream();
  const slots = data.appIds.map((appId) => ({ slot_app_id: appId }));
  const displays = useSlotAppDisplays(slots);

  const handleRetry = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) void sendMessage({ parts: lastUser.parts });
  };

  return (
    <div className="rounded-xl border border-border p-4 my-1.5 flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium text-foreground">
          Connect to use “{data.agentTitle}”
        </p>
        <p className="text-xs text-muted-foreground">
          This agent needs your personal connections before it can run.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {slots.map((slot) => (
          <ConnectSlotRow
            key={slot.slot_app_id}
            display={
              displays[slot.slot_app_id] ?? {
                kind: "fallback",
                title: slot.slot_app_id,
                icon: null,
                registryItem: null,
              }
            }
            orgSlug={org.slug}
          />
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs self-start"
        onClick={handleRetry}
      >
        Retry
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS. If `useChatStream` is exported under a different name (Step 1) or `sendMessage`'s param differs, adjust the import/call accordingly. `sendMessage({ parts })` matches `SendMessageParams` in `chat-context.tsx`.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/components/chat/connect-card.tsx
git commit -m "feat(chat): add ConnectCard rendered from data-connect-required"
```

---

## Task 8: Render the card in the message switch (frontend)

**Files:**
- Modify: `apps/mesh/src/web/components/chat/message/assistant.tsx` (the `MessagePart` switch, data-* cases ~491-495)

- [ ] **Step 1: Import the card**

Add to the imports in `assistant.tsx`:

```ts
import { ConnectCard } from "@/web/components/chat/connect-card";
```

- [ ] **Step 2: Add a render case BEFORE the null data-* group**

Find the grouped null cases (around lines 491-495):

```ts
    case "data-tool-metadata":
    case "data-tool-subtask-metadata":
    case "data-generate-image":
    case "data-web-search":
      return null;
```

Insert this case immediately ABOVE them:

```ts
    case "data-connect-required":
      return <ConnectCard data={part.data} />;
```

(`part.data` is typed `{ agentId, agentTitle, appIds }` via the `connect-required` registration from Task 3.)

- [ ] **Step 3: Type-check**

Run: `bun run --cwd apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/components/chat/message/assistant.tsx
git commit -m "feat(chat): render ConnectCard for data-connect-required parts"
```

---

## Task 9: Remove the upfront gate and delete dead code

**Files:**
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx` (remove lines 314-321, 363-378, and imports at 79-80)
- Delete: `connect-agent-gate.tsx`, `use-unresolved-slots.ts`, `unresolved-slots.ts`, `unresolved-slots.test.ts`

- [ ] **Step 1: Remove the gate check (current lines 314-321)**

Delete this block (including its leading comment):

```ts
  // Suspense-based: AgentInsetProvider suspends until slot resolution settles,
  // so the gate decision is made before any panel renders (no flash).
  const { unresolved } = useUnresolvedSlots(
    org.id,
    org.slug,
    entity?.slots ?? [],
  );
  const showConnectGate = unresolved.length > 0;
```

- [ ] **Step 2: Remove the gate render (current lines 363-378)**

Delete this entire block:

```ts
  if (showConnectGate) {
    return (
      <InsetContext value={insetContextValue}>
        <div className="flex-1 min-h-0 pr-1.5 pb-1.5 overflow-hidden">
          <div className="h-full bg-background card-shadow rounded-[0.75rem] overflow-hidden">
            <ConnectAgentGate
              agentTitle={entity?.title ?? ""}
              agentIcon={entity?.icon ?? null}
              slots={unresolved}
              orgSlug={org.slug}
            />
          </div>
        </div>
      </InsetContext>
    );
  }
```

- [ ] **Step 3: Remove the now-unused imports**

Delete the import lines for `ConnectAgentGate` and `useUnresolvedSlots` (around lines 79-80). Find them:

Run: `rg -n 'ConnectAgentGate|useUnresolvedSlots' apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`
Then delete those two import statements. (If `InsetContext` becomes unused after removing the block, delete its import too — let the type-check in Step 5 tell you.)

- [ ] **Step 4: Delete the dead files**

```bash
git rm apps/mesh/src/web/components/chat/connect-agent-gate.tsx \
       apps/mesh/src/web/hooks/use-unresolved-slots.ts \
       apps/mesh/src/web/hooks/unresolved-slots.ts \
       apps/mesh/src/web/hooks/unresolved-slots.test.ts
```

- [ ] **Step 5: Type-check + lint + knip**

Run: `bun run check`
Expected: PASS.
Run: `bun run lint`
Expected: no NEW errors (pre-existing `useEffect`/memoization warnings in unrelated chat code are acceptable).
Run: `bunx knip` (or the repo's knip script) and confirm no dead-code warnings for `use-slot-app-displays.ts` / `connect-slot-row.tsx` — they are now imported by `ConnectCard`. If knip flags anything you removed an importer of, fix by removing the truly-dead export.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(chat): remove upfront connect gate in favor of inline connect card"
```

---

## Task 10: End-to-end tests

**Files:**
- Create: `apps/mesh/e2e/tests/connect-card.spec.ts` (follow the structure of an existing slot/agent e2e spec — find one first)

- [ ] **Step 1: Find an existing e2e to model after**

Run: `rg -l 'slot|virtualMcp|subtask' apps/mesh/e2e/tests`
Read the closest match to mirror its setup helpers (org + user + agent creation, OAuth/connection seeding).

- [ ] **Step 2: Write the parent-gate scenario**

Author a test that: creates an agent with a typed slot for an app the user has NOT connected; opens the agent chat; sends a message; asserts a connect card renders (locator for the “Connect to use” heading + a Connect button) and the composer was NOT blocked beforehand. Then simulate the connection existing and click Retry; assert the run proceeds (no card on the new turn). Use the real Postgres/NATS harness per TESTING.md. Mirror the seeding approach from the spec found in Step 1 — do not stub `MeshContext`.

- [ ] **Step 3: Write the subagent scenario**

Author a test that: creates a parent agent able to delegate, and a subagent with an unresolved slot; drives the parent to call `subtask` (seed a deterministic prompt/agent so the model delegates, or invoke the subtask path directly via the harness e2e entry); assert an inline connect card appears under the subtask call and the parent run does not hard-fail.

- [ ] **Step 4: Run the e2e**

Run: `bun run --cwd apps/mesh test:e2e connect-card` (use the repo's actual e2e command — check `apps/mesh/package.json`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/e2e/tests/connect-card.spec.ts
git commit -m "test(e2e): connect card for unresolved parent and subagent slots"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full type-check**

Run: `bun run check`
Expected: PASS across all workspaces.

- [ ] **Step 2: Lint + format**

Run: `bun run lint` (no new errors) then `bun run fmt`.

- [ ] **Step 3: Unit tests**

Run: `bun test apps/mesh/src/core/slot-resolver.test.ts apps/mesh/src/harnesses/decopilot/built-in-tools/subtask.test.ts`
Expected: PASS.

- [ ] **Step 4: Dead-code check**

Run the repo's knip command; expected clean (no orphaned exports from the gate removal).

- [ ] **Step 5: Commit any formatting**

```bash
git add -A
git commit -m "chore: fmt for just-in-time connect gate" || echo "nothing to format"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** §1 goal → Tasks 4/5/7/8; §2 collect-all error → Tasks 1/2; §3 typed chunk at both boundaries → Tasks 3/4/5; §4 model text → Task 4 (subagent) + Task 5 (parent returns, model sees no tool failure); §5 one card renderer → Tasks 6/7/8; §5 gate removal → Task 9; §6 edge cases (parallel subtasks keyed by `toolCallId`, mid-session disconnect via the same throw) → covered by Tasks 4 + 2; §7 testing → Tasks 1/2/10.
- **Type consistency:** `SlotUnresolvedError(appIds: string[], agentId: string, agentTitle: string)` and `.appIds/.agentId/.agentTitle` are used identically in Tasks 1, 2, 4, 5. The chunk `data` shape `{ agentId, agentTitle, appIds }` matches the `connect-required` registration (Task 3) and `ConnectCardData` (Task 7) and `part.data` (Task 8).
- **Parent vs subagent rendering:** the parent emits the chunk with no `id` (one appended visible part); the subagent emits with `id: toolCallId`. Both render via the same `data-connect-required` switch case — rendering does NOT depend on `id`, so both work.
- **Risk to verify during execution:** that `pl.writer.write(...)` followed by `return` in `index.ts` (Task 5) flushes the card chunk to the client before the run ends. `writer` is the `createUIMessageStream` writer (same one `subtask.ts` uses successfully), so it should; confirm in the Task 10 parent e2e. If it does not flush, fall back to writing the chunk and then yielding a terminal finish chunk rather than bare `return`.
