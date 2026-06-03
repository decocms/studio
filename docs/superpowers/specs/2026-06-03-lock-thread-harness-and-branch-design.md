# Lock thread harness, sandbox provider, and branch after first message

**Date:** 2026-06-03
**Status:** Design — awaiting user review
**Area:** `apps/mesh` (web client + submit route)

## Problem

The chat input pickers (harness, sandbox provider kind, branch, model, tier,
mode, credential) are driven by a single global `useChatPrefs()` context backed
by `localStorage`. Their selections are captured into the `threads` row on the
**first** message of a thread (as `harness_id`, `sandbox_provider_kind`,
`branch`, and `run_config` JSON), but on every subsequent send the client
**re-reads the global pickers** and ships those values to the server. Nothing
on the read path rehydrates from the thread row.

Concretely, this means: a user starts thread A on `claude-code` against branch
`main`, then opens a different (new) chat composer and flips the harness to
`codex` for that next chat. If they then return to thread A and send a
follow-up, the follow-up is dispatched with `harnessId: codex` and
`branch: <whatever the picker now shows>` — silently. The user is given no
indication that thread A's runtime just changed underneath them.

This is the "fatal flaw" we're fixing.

## Goals

1. Once a thread has been started, the **harness**, **sandbox provider kind**,
   and **branch** it runs on are immutable for the life of the thread.
2. The UI advertises that lock — the user can see what the thread is locked to
   and is told how to use different settings (start a new chat).
3. Any attempt by the client to override those three fields for a started
   thread is dropped server-side (defense-in-depth).
4. Model, tier, mode, and credential are explicitly **not** locked — users may
   change them freely between sends within the same thread.

## Non-goals

- Per-thread persistence of model / tier / mode / credential. These continue to
  be globally controlled.
- A "thread settings" override surface that lets users intentionally change a
  thread's harness or branch post-creation. No such surface exists today and
  none is being added.
- Migrating legacy threads (those with `harness_id IS NULL`) to a locked state.
  They keep current global-pref behavior; they were never locked.
- Any change to the database schema. Everything we need is already columnar on
  `threads`.

## Background — what the server already persists

The `threads` table already carries everything required:

- `threads.harness_id` (column) — set on first message
- `threads.sandbox_provider_kind` (column) — set on first message, paired with
  the harness selection
- `threads.branch` (column) — set on first message
- `threads.run_config` (jsonb) — full `PersistedRunConfig` shape with `models`,
  `agent`, `temperature`, `toolApprovalLevel`, `mode`, `windowSize`,
  `triggerId` (see `apps/mesh/src/api/routes/decopilot/run-config.ts`)

The bug is **not** a missing storage layer; it is a missing read path on the
client and a missing guard on the server submit route.

## Design

### Scope of the lock

**Locked at first message (immutable):**

- `harness_id`
- `sandbox_provider_kind` (always travels with harness as a pair; the existing
  `AgentOption` enum already models them jointly)
- `branch`

**Stays globally controlled (per-send):**

- `tier` (`fast` / `smart` / `thinking`)
- `mode` (`default` / `plan` / `web-search` / `gen-image`)
- chat model, image model, deep research model
- `credentialId`
- `toolApprovalLevel`

### Client — read path

Files: `apps/mesh/src/web/components/chat/chat-context.tsx`,
`apps/mesh/src/web/components/chat/input.tsx`,
`apps/mesh/src/web/components/chat/task/types.ts`.

The lock predicate is a single condition: **`activeTask?.harness_id != null`**.
When that is true, the thread is locked and all three fields (harness,
sandbox, branch) are sourced from the thread row. We do not lock on a
per-field basis — `harness_id` being non-null is the marker that "first
message has been processed and the runtime is pinned." `sandbox_provider_kind`
may legitimately be null for some harness/run setups; an absent sandbox kind
on a locked thread simply maps to "no sandbox kind" and is forwarded as
such.

1. `ActiveTaskProvider` already loads the active thread (`activeTask`). Expose
   four new derived values through `useChatPrefs()`:

   - `isThreadLocked: boolean` — `activeTask?.harness_id != null`
   - `lockedHarness: HarnessId | null` — `activeTask?.harness_id ?? null`
   - `lockedSandbox: SandboxProviderKind | null` — `activeTask?.sandbox_provider_kind ?? null`
   - `lockedBranch: string | null` — `activeTask?.branch ?? null`

2. The existing `effectiveAgentOption` computation
   (chat-context.tsx ~lines 521-533) currently derives the harness/sandbox pin
   from `pendingAgentOption` (localStorage-backed). Change it to:

   ```ts
   const effectiveAgentOption = isThreadLocked
     ? agentOptionFor(lockedHarness, lockedSandbox)
     : pendingAgentOption;
   ```

   When locked, the global picker state is bypassed entirely; the existing
   downstream pins (`pendingHarnessId`, `pendingSandboxProviderKind`) become
   driven by the lock instead of by localStorage.

3. The branch picker, when `isThreadLocked` is true, displays `lockedBranch`
   (which may be null — render as "(no branch)" or the existing empty-state
   label). When not locked, it reads from its current global source.

### Client — write path

Files: `apps/mesh/src/web/components/chat/chat-context.tsx`
(`sendMessageInternal`, ~lines 918-988),
`apps/mesh/src/web/components/chat/thread-connection.ts` (`RequestOptions`).

Extract the "compute submit settings" decision into a pure helper so we can
unit-test it. The helper omits the three locked fields entirely when the
thread is locked — the server is responsible for reading them from the row
and is the actual enforcement point.

```ts
// apps/mesh/src/web/components/chat/resolve-submit-settings.ts
export function resolveSubmitSettings(args: {
  thread: { harness_id?: string | null;
            sandbox_provider_kind?: string | null;
            branch?: string | null } | null;
  globals: { harnessId?: HarnessId;
             sandboxProviderKind?: SandboxProviderKind;
             branch?: string | null };
}): Pick<RequestOptions, "harnessId" | "sandboxProviderKind" | "branch"> {
  // Lock predicate: thread row's harness_id is set.
  if (args.thread?.harness_id != null) {
    return {}; // harness / sandbox / branch all omitted
  }
  return {
    harnessId: args.globals.harnessId,
    sandboxProviderKind: args.globals.sandboxProviderKind,
    branch: args.globals.branch ?? null,
  };
}
```

`sendMessageInternal` calls this helper instead of inlining the three fields.
The other RequestOptions fields (`tier`, `mode`, `toolApprovalLevel`, `system`,
`agent`) are populated as today, from current global prefs.

### Server — the actual lock

File: `apps/mesh/src/api/routes/decopilot/routes.ts`, function `validate()`
(~lines 236-316). This is the HTTP entry that consumes RequestOptions from
the client and builds the `DispatchRunInput`. Today it extracts `harnessId`,
`sandboxProviderKind`, `branch` directly from the body and then calls
`resolvePerRequestModels(ctx, tier, harnessId)` (line 276) to pick the model
for that harness+tier.

The guard must run **before** `resolvePerRequestModels`, because if a locked
thread overrides the harness, the model resolution must use the locked
harness — otherwise we'd resolve models for the client-requested harness
while dispatching to a different one, which would be a silent correctness
bug worse than the one we started with.

Concretely, after `taskIdInput` is resolved (line 269) and before
`resolvePerRequestModels` (line 276), insert:

```ts
// Lock guard: once a thread row carries a harness_id, it's pinned for life.
// Any client-provided override is dropped, and the per-request model
// resolution below uses the locked harness.
let effectiveHarnessId = harnessId;
let effectiveSandboxProviderKind = sandboxProviderKind;
let effectiveBranch = branch;
if (taskIdInput) {
  const thread = await ctx.storage.threads.get(taskIdInput);
  if (thread?.harness_id) {
    if (harnessId && harnessId !== thread.harness_id) {
      ctx.log?.warn?.("decopilot.submit: ignored harness override on locked thread", {
        threadId: taskIdInput,
        requested: harnessId,
        locked: thread.harness_id,
      });
    }
    effectiveHarnessId = thread.harness_id as HarnessId;
    effectiveSandboxProviderKind =
      (thread.sandbox_provider_kind as SandboxProviderKind | null) ?? null;
    effectiveBranch = thread.branch ?? null;
  }
}

const resolvedModels = await resolvePerRequestModels(
  ctx, tier, effectiveHarnessId,
);
// ... rest of validate() uses effectiveHarnessId / effectiveSandboxProviderKind
//     / effectiveBranch in the returned object.
```

The `ctx.storage.threads.get()` call is already a known pattern in this
folder (`helpers.ts` line 401, `on-title-updated.ts`).

This is the actual lock. A buggy or stale client cannot bypass it; trigger
flows and automation paths that re-enter `validate()` are also covered;
even direct API callers are covered.

### UI affordance

File: `apps/mesh/src/web/components/chat/input.tsx`.

When `lockedHarness` is set:

- The harness pill (~lines 539-554) renders as a **non-interactive chip**:
  small lock icon + harness label + sandbox label. `cursor-default`, no hover
  popover, no click handler.
- Tooltip on hover: *"This chat is using {harness label · sandbox label}.
  Start a new chat to use a different runtime."*
- The branch picker renders the same way: lock icon + branch name + same
  tooltip pattern, swapping "runtime" for "branch."
- Model, tier, mode, image, and deep-research pickers remain fully
  interactive and unchanged.

When `lockedHarness` is null (new chat being composed, or legacy thread with
`harness_id IS NULL`), all pickers behave exactly as today.

No new icons, modals, or routes. The chip uses the existing pill styling with
a lock icon glyph.

## Edge cases

- **Legacy threads (`harness_id IS NULL`).** `lockedHarness` is null →
  pickers stay live → existing global-pref behavior. They can never be
  retroactively locked; this is acceptable. They are pre-existing and rare.
- **Brand-new thread, between thread-row creation and first message.** The
  row exists but `harness_id` is still null. `lockedHarness` is null →
  first-message send ships harness/sandbox/branch from globals → server
  captures them onto the row. Subsequent sends see `harness_id` populated →
  locked. Single race-free check on a single column.
- **Thread switching mid-session.** The harness chip and branch chip
  recompute from `activeTask` when the active thread changes; this is just a
  re-render through the existing `ActiveTaskProvider`. Tier/model pickers
  don't change.
- **`activeTask` not loaded yet (loading state).** Treat as "not locked yet"
  but disable the send button while loading (already done today). No risk of
  shipping wrong settings because send is gated on having a loaded thread.
- **Trigger-initiated threads.** Same rule applies — once `harness_id` is on
  the row (set by the trigger run), follow-up user sends are locked to it.

## Testing

### Unit (`bun test`, co-located)

`apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts`:

1. Legacy thread with `harness_id: null` → returns all three from globals.
2. Locked thread → returns `{}` (all three omitted), regardless of what
   globals contain.
3. Locked thread + globals try to override → globals stripped (the absence of
   keys is what proves the lock at the client layer).
4. No active thread (composing new chat) → returns all three from globals.

These are pure-function tests; no mocks, no DB, no React.

### E2E (Playwright, `apps/mesh/e2e/tests/`)

Scenario: `chat-locked-harness.spec.ts`

1. Sign in, create a virtual MCP, navigate to chat.
2. In picker, select harness `codex`, branch `main`. Send first message in
   thread A. Wait for response.
3. Open a new chat composer. Change global harness to `claude-code`,
   change branch picker to `feature-x`.
4. Navigate back to thread A.
5. Assert: harness chip shows `Codex` with lock icon; branch chip shows
   `main` with lock icon. Tooltips render the expected copy.
6. Send a follow-up message in thread A.
7. Assert (DB or run inspector): the dispatched run used
   `harness_id: codex`, `branch: main`. The original thread row's
   `harness_id` and `branch` are unchanged.
8. Server-side guard: simulate a stale client by issuing a submit with an
   overridden `harnessId` to a locked thread (raw API call). Assert the
   dispatched run still uses the thread's persisted harness, and a warn log
   was emitted.

## File-by-file change list

- `apps/mesh/src/web/components/chat/resolve-submit-settings.ts` — **new**
  pure helper + types.
- `apps/mesh/src/web/components/chat/resolve-submit-settings.test.ts` — **new**
  unit tests.
- `apps/mesh/src/web/components/chat/chat-context.tsx` — expose
  `lockedHarness` / `lockedSandbox` / `lockedBranch` from `useChatPrefs()`;
  update `effectiveAgentOption`; update `sendMessageInternal` to use the new
  helper.
- `apps/mesh/src/web/components/chat/input.tsx` — render harness pill and
  branch picker as locked chips when `lockedHarness` is set; add tooltip
  copy.
- `apps/mesh/src/api/routes/decopilot/routes.ts` — add the lock guard in
  `validate()` between `taskIdInput` resolution and `resolvePerRequestModels`,
  and use the resulting `effective*` values in the returned `DispatchRunInput`.
- `apps/mesh/e2e/tests/chat-locked-harness.spec.ts` — **new** E2E.

## Risks and open considerations

- **Trigger flows / automation paths.** Any internal caller that re-enters
  `validate()` with hardcoded RequestOptions on a locked thread will have
  its harness/branch silently overridden by the guard. This is the
  intended semantic (the thread is the source of truth), but worth a
  quick scan during implementation to confirm no caller depends on
  per-message harness drift.
- **`AgentOption` derivation.** The mapping from `(harness, sandbox)` back
  to the `AgentOption` enum needs a small `agentOptionFor(harness, sandbox)`
  helper; the inverse already exists (`AGENT_OPTION_PINS`). Trivial but
  worth being explicit so the implementer doesn't get stuck.
- **`ctx.log` shape.** The exact logger surface used by `validate()` should
  be confirmed during implementation (`ctx.log?.warn?.(…)` is the assumed
  shape based on `helpers.ts`); use the project's conventional logger here,
  not `console`.
