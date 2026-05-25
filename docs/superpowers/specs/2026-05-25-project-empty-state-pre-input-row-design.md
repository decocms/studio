# Project chat empty state — pre-input row & tier-only model pill

**Status:** Draft — pending review
**Date:** 2026-05-25
**Scope:** UI refactor only. No backend changes.

## Problem

The project/website chat empty state (`SidebarEmptyState` in
`apps/mesh/src/web/components/chat/side-panel-chat.tsx`) renders a
branch chip in the centered card. The chip is informational but
isolated — there is no companion control for choosing where the agent
runs (Cloud vs Local desktop CLI). Today that choice is buried inside
the model pill in the chat input, which merges two orthogonal axes:

1. **Where the run happens** — Decopilot (cloud) vs Claude Code or
   Codex (user-desktop).
2. **Which model tier** — Auto / Sonnet / Opus / etc.

Mixing the two into one popover makes both harder to scan and
discourages users from switching modes.

## Goal

Promote the run-location choice into a dedicated row that sits
*just above* the chat input, alongside the branch picker. Reduce the
in-input model pill to a tier-only control. Keep all backend wiring
(`conn.submit` options, `resolveTier`, `resolveAgentTier`,
`AGENT_OPTION_PINS`) untouched.

## Non-goals

- Home page chat input (no repo/branch concept there).
- Side-panel chats for non-clonable virtual MCPs (no row rendered).
- Backend changes to provider/tier resolution.
- Mid-thread switching of location or branch — both lock after the
  thread has messages, matching today's `BranchPill` behavior.

## Locked design decisions

| Area | Decision |
|---|---|
| Scope | Project/website empty state only (`SidebarEmptyState`) |
| Row contents | Branch picker + segmented mode picker (Cloud / Local·CC / Local·Codex) |
| Mode picker options | 3 mutually exclusive modes; unavailable CLIs greyed but visible |
| Model pill | Simplified to Fast / Smart / Thinking; subtitle = resolved model |
| Locked after active | Both row controls lock once `isActive` (matches `BranchPill`) |
| Wiring | New picker writes to existing `pendingAgentOption` + `pendingTier`; submit-time options unchanged |
| Eager VM start | Kept; moves from `AgentModelTrigger` into `ModePicker.onSelect` |
| Centered card | Keep icon + title + description + ice breakers; drop branch chip |
| Row placement | Sibling inside `<Chat.Footer>`, above `<Chat.Input>` |
| State model | Approach 1 — keep unified `pendingAgentOption`; add selector hooks |

## Layout

```
+----------------------------------------------------------+
|                  [Integration icon]                      |
|                    New Website                           |
|         Website cloned from a public template            |
|                                                          |
|                  <IceBreakers />                         |
+----------------------------------------------------------+
| ⎇ main ⌄      ☁ Cloud ⌄         <-- new ChatModeRow      |
+----------------------------------------------------------+
| Ask anything, / for prompts, @ for ...                   |
|                                                          |
| [≋ Tools]                Smart ⌄    [🎙][↑]              |
+----------------------------------------------------------+
```

### ModePicker pill (closed)

| Mode | Label | Style |
|---|---|---|
| `cloud-decopilot` | ☁ Cloud ⌄ | muted-foreground |
| `local-claude-code` | 🖥 Claude Code ⌄ | text-success / bg-success/10 |
| `local-codex` | 🖥 Codex ⌄ | text-success / bg-success/10 |

The success styling on Local modes mirrors today's "Desktop connected"
affordance from `NoAiProviderEmptyState`.

### ModePicker popover

```
+------------------------------+
| ☁ Cloud                      |
|   Decopilot               ✓  |
+------------------------------+
| 🖥 Local                      |
|   Claude Code                |
|     [● Connected]            |
|   Codex                      |
|     [○ Not connected]        |
+------------------------------+
```

Unavailable CLIs (not in the link table) render as informational rows,
not disabled. Clicking them routes to the existing desktop-connect
flow (the same target as the current `NoAiProviderEmptyState` hint).

### TierTrigger popover (mode-dependent subtitle)

`Cloud · Decopilot` (admin set Sonnet 3.7 in org settings):

```
+-------------------------+
| Fast                    |
|   Haiku 3.5             |
| Smart                   |
|   Sonnet 3.7         ✓  |
| Thinking                |
|   Opus 4                |
+-------------------------+
```

`Local · Claude Code`:

```
+-----------------------+
| Fast                  |
|   Haiku               |
| Smart                 |
|   Sonnet           ✓  |
| Thinking              |
|   Opus                |
+-----------------------+
```

When mode = `cloud-decopilot` and neither an explicit slot nor a
resolvable fallback exists, the subtitle is hidden. The row stays
selectable; the server surfaces `TierUnavailableError` at send time.
This keeps error handling in one place.

## Component map

```
NEW
  apps/mesh/src/web/components/chat/pills/mode-picker.tsx
    Popover trigger pill (3 mutually-exclusive modes) + popover body.
    - Reads useChatMode(), useCurrentLink() (for `.online` + `.capabilities`)
    - Writes via setChatMode(...)
    - Fires startVm.mutate(...) on local mode select when a branch is set

  apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx
    Thin layout: BranchPill + ModePicker.
    - Gated on agentHasClonableSource(metadata)
    - locked = useOptionalChatStream().messages.length > 0

  apps/mesh/src/web/components/chat/use-chat-mode.ts
    Selector hooks over the existing chat prefs:
      useChatMode()       → "cloud-decopilot" | "local-claude-code" | "local-codex"
      useChatTier()       → "fast" | "smart" | "thinking"
      setChatMode(m)      → routes to setPendingAgentOption(...)
      setChatTier(t)      → existing prefs writer
      useTierSubtitle(mode, tier) → string | null

REPURPOSED (renamed agent-model-trigger.tsx → tier-trigger.tsx)
  apps/mesh/src/web/components/chat/tier-trigger.tsx
    Tier-only pill + popover. No agent-section logic; no eager VM
    start side-effect; no success styling (moved to ModePicker).

MODIFIED
  apps/mesh/src/web/components/chat/side-panel-chat.tsx
    - SidebarEmptyState: drop the `{showBranchPicker && <ThreadPills/>}`
      block; keep icon + title + description + ice breakers.
    - ChatPanelContent: render <ChatModeRow/> as the first child of
      <Chat.Footer>, above <Chat.Input>, on both branches of the
      isChatEmpty conditional.

  apps/mesh/src/web/components/chat/chat-context.tsx
    - Expose `setChatMode(mode)` as a thin wrapper over the existing
      `setPendingAgentOption` writer.
    - No behavioral changes at submit time (`conn.submit` payload
      shape and field set unchanged).

DELETED
  apps/mesh/src/web/components/chat/pills/thread-pills.tsx
    Single-call wrapper around BranchPill; its only call-site
    (SidebarEmptyState) goes away.

  apps/mesh/src/web/components/chat/agent-model-popover.tsx
  apps/mesh/src/web/components/chat/select-model/agent-models.tsx
  apps/mesh/src/web/components/chat/select-model/agent-section.tsx
  apps/mesh/src/web/components/chat/select-model/desktop-cli.tsx
    The merged location+tier popover is replaced by ModePicker +
    TierTrigger. Implementation step MUST grep each file before
    deletion to confirm no other call-sites remain.
```

## Tier-subtitle resolution

`useTierSubtitle(mode, tier)` mirrors what the server does in
`resolveTier()`, using only client hooks that already exist:

```
mode === "cloud-decopilot"
  1. const slot = useSimpleMode().tiers[tier]
  2. if (slot) return slot.title ?? slot.modelId
  3. const keys = useAiProviderKeys()
  4. const modelsByKeyId = useAiProviderModels(...keys)   // cached per-key
  5. const defaults = pickSimpleModeDefaults(keys, modelsByKeyId)
  6. const pick = defaults.chat[tier]
  7. return pick?.title ?? pick?.modelId ?? null

mode === "local-claude-code" or "local-codex"
  const harness = mode === "local-codex" ? "codex" : "claude-code"
  return resolveAgentTier(harness, tier)?.label ?? null
  // Source of truth: ai-providers/agent-tiers.ts (server-safe file
  // already shared between dispatch path and web).
```

Both paths read from the same SoTs the backend uses, so labels in the
popover always match what the server will actually run.

## Submit-time data flow (unchanged)

```
conn.submit({
  messages: ...,
  options: {
    ...
    harnessId:           pendingHarnessId           || undefined,
    sandboxProviderKind: pendingSandboxProviderKind || undefined,
    tier:                pendingTier                || undefined,
  },
});
```

Mode → existing prefs mapping (via `AGENT_OPTION_PINS`, unchanged):

| Mode | `pendingAgentOption` | `pendingHarnessId` | `pendingSandboxProviderKind` |
|---|---|---|---|
| `cloud-decopilot` | `decopilot` | `decopilot` | `cloud` |
| `local-claude-code` | `claude-code-desktop` | `claude-code` | `user-desktop` |
| `local-codex` | `codex-desktop` | `codex` | `user-desktop` |

## Eager VM start

Moves verbatim from `agent-model-trigger.tsx:105-110` to
`mode-picker.tsx`'s `onSelect`:

```
if (mode !== "cloud-decopilot" && currentBranch) {
  startVm.mutate({
    virtualMcpId,
    branch: currentBranch,
    sandboxProviderKind: "user-desktop",
  });
}
```

## Locked state

After the thread has any messages (`useOptionalChatStream().messages.length > 0`):

- `BranchPill` already renders as a plain span (unchanged).
- `ModePicker` renders the same closed-pill chrome but as a `<span>`
  with no chevron, no popover trigger. Tooltip: "Fixed for this thread".
- `TierTrigger` continues to be interactive — tier can change between
  turns. (Today's behavior; unchanged.)

## Tests

| File | Coverage |
|---|---|
| `pills/mode-picker.test.tsx` | 3 rows in fixed order; greys missing CLIs; setChatMode + close on click; startVm fires for local + currentBranch only; locked → plain span + tooltip |
| `pills/chat-mode-row.test.tsx` | Returns null when not clonable; forwards `locked=isActive`; layout = BranchPill + ModePicker |
| `use-chat-mode.test.ts` | Round-trip mode write/read; useTierSubtitle returns expected label per mode/tier; null when nothing resolvable |
| `tier-trigger.test.tsx` | Closed pill shows tier only; popover subtitles re-resolve when mode changes; setChatTier + close on click |
| `side-panel-chat.test.tsx` | SidebarEmptyState no longer renders ThreadPills; Chat.Footer renders ChatModeRow on clonable VM and omits on non-clonable |

Removed tests: any covering `ThreadPills`, `AgentModelPopover`,
`getAgentSections` (delete with the source).

Not tested (intentionally): server-side resolve-tier / dispatch path
(unchanged), `RequestOptions` schema (unchanged).

## Risks & open questions

- **Deletion safety:** `ThreadPills`, `AgentModelPopover`,
  `agent-models.tsx`, `agent-section.tsx`, `desktop-cli.tsx` were
  identified as having only the call-sites covered above. The
  implementation step MUST grep each before deletion to catch any
  call-site missed by exploration.
- **`useAiProviderModels` cost:** rendering the TierTrigger popover
  fires one `listModels` query per provider key when no admin slot
  exists. React Query caching makes subsequent opens free, but the
  first open after a fresh page load will fan out N requests. Acceptable
  because (a) most orgs have ≤3 keys and (b) the query is gated on
  popover-open (not eager). Revisit if telemetry shows long popover
  load times.
- **Decopilot "no-resolvable-fallback" UX:** rows stay selectable
  with hidden subtitle; the error surfaces at send via
  `TierUnavailableError`. Alternative — show "Connect a provider" inline
  in the popover — was rejected to keep error handling unified.

## Out of scope (follow-ups, not blockers)

- Promoting the pre-input row to the home-page chat input (separate
  design; row would need a project picker, which the home page
  currently lacks).
- A 4th "Auto" tier returning to the popover.
- Per-message tier overrides (cmd-click on send to use a different tier).
