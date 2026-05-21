# Merge AgentPill and AgentModelTrigger — Design

**Status:** Draft · 2026-05-21
**Owner:** @tlgimenes

## Goal

Collapse the two stacked selectors around the chat composer — the `AgentPill` (Decopilot vs Claude Code vs Codex, in `ThreadPills`) and the `AgentModelTrigger` (Fast/Smart/Thinking tier inside the chat input) — into a single sectioned popover triggered from the chat input. A row click picks both agent and tier in one action, and laptop-CLI sections (Claude Code, Codex) carry a green styling that matches the "Desktop connected" affordance already used in `NoAiProviderEmptyState`.

## Motivation

Today the user has to use two surfaces to fully reconfigure their next message: the `AgentPill` (above the composer) for the agent, and the `AgentModelTrigger` (inside the composer) for the tier. The pill also locks once the thread has messages, which makes its "header" position awkward — it stops being interactive but still takes space. Folding both into one popover behind the model trigger:

1. Single click reconfigures both axes.
2. The chat input strip stays compact (one trigger instead of two).
3. The popover becomes the discovery surface for "what agents do I have" — it explicitly differentiates cloud (Decopilot) from local-runtime agents with the same green token the rest of the app uses for local CLI status.

## Non-goals

- We do not allow swapping agents mid-thread. Lock semantics match today: once a thread has messages, the agent choice freezes; only tier can change.
- We do not touch `NoAiProviderEmptyState` (the full-screen "no providers yet" page). It owns its own discovery flow upstream.
- We do not redesign the Decopilot full-model browser (the existing two-pane picker). It stays mounted on the settings page if it has any other callers; in the chat surface it goes away.

## Decisions

### Scope: drop `decopilot-laptop`

Today there are four `AgentOption`s: `decopilot`, `decopilot-laptop`, `claude-code-laptop`, `codex-laptop`. The `decopilot-laptop` variant ran cloud Decopilot through the local sandbox runtime. We **remove it entirely** — the popover surfaces three sections (`decopilot`, `claude-code`, `codex`) and `decopilot-laptop` is dropped from the `AgentOption` type, `AGENT_OPTION_PINS`, `computeAgentOptions` callers, and its localStorage value migrates silently to `null` (existing validation already falls back when the stored string isn't in `AGENT_OPTION_PINS`).

### What can NOT be deleted (constraints found during exploration)

- `SimpleModeTierDropdown` — still used by `apps/mesh/src/web/views/automations/automation-detail.tsx`. Stays.
- `ModelSelectorBody` / `ModelSelectorStandaloneBody` / `LaptopCliModelSelectorBody` — still used by the `ModelSelector` wrapper in `apps/mesh/src/web/components/chat/select-model.tsx`, which is called from `apps/mesh/src/web/views/settings/ai-providers/simple-mode-section.tsx`. They stay (the chat input simply stops calling them).
- `AGENT_OPTION_PINS`, `pinsForOption`, `pinsToOption` — still used by `chat-context.tsx` and `thread-pills.tsx` to map the persisted option to `(harness, sandbox)`. Stay.

What CAN be deleted: `AgentPill`, `computeAgentOptions`, `AGENT_OPTION_LABELS`, `AgentOptionsInput`, the `ORDER` array, and the `decopilot-laptop` entries.

### UI surface

**Closed trigger (in the chat input).** Same position as today (right side of bottom action row). Renders logo + current selection label.

- Active = Decopilot: `tier glyph + "Fast"|"Smart"|"Thinking"`, neutral colors.
- Active = Claude Code or Codex: `agent logo + model label` (e.g. "Opus 4.7"), with `text-success` on label and a faint `bg-success/10` ring. This is the green signal that "your runtime is local".
- Locked thread: same content, same styling. The popover opens but non-active sections are disabled (see below).

**Open popover (~`w-72`).** Three sections, in order:

1. `Decopilot` — three rows: ⚡ Fast / ✦ Smart / ◆ Thinking. Each row shows description ("Quicker responses" / "Balanced quality" / "Deeper reasoning").
2. `Claude Code · on this laptop` — three rows: Haiku 4.5 / Sonnet 4.6 / Opus 4.7. Same description column.
3. `Codex · on this laptop` — three rows: GPT-5.4 Mini / GPT-5.3 Codex / GPT-5.5.

Section headers are `text-muted-foreground text-xs`. Local-CLI sections (Claude Code, Codex) sit on a faint `bg-success/5` band and their header text goes `text-success`. The current selection is marked with the existing "On" chip used by `SimpleModeTierDropdown` today.

**Locked-thread popover.** When the thread has messages, only the section matching the persisted `threadHarness` is interactive. The other two sections render with `opacity-40 pointer-events-none` and a small lock icon on the header — the user can still see what exists, they just can't click it.

**Offline laptop CLI.** When `link.online === false`, CLI sections are *hidden* (not shown disabled). Matches today's `computeAgentOptions` gating behavior; discovery of CLI agents is the `NoAiProviderEmptyState` card's job.

### Gap bug fix

`AgentModelTrigger`'s button currently uses `gap-1.5` while the label-span collapses to `max-w-0 opacity-0` at narrow widths via container queries. The parent gap survives the collapse, leaving a phantom 6px between the logo and the chevron. Fix by making the gap container-responsive: `gap-0 @[496px]/chat-bottom:gap-1.5`. Applies to all three agent variants since they share the trigger.

### Data model

A single `AgentSection[]` drives the popover. Built by a pure function `getAgentSections({ hasAnyKey, link })` that subsumes today's `computeAgentOptions` (which goes away with `AgentPill`).

```ts
export type AgentKind = "decopilot" | "claude-code" | "codex";

export interface AgentTierEntry {
  modelId: string | null;   // null for Decopilot — server resolves via provider key
  label: string;            // "Smart", "Sonnet 4.6", "GPT-5.3 Codex"
  description: string;      // tier description
  icon: ReactNode | string; // glyph for Decopilot tiers; logo url for CLI rows
}

export interface AgentSection {
  kind: AgentKind;
  title: string;            // "Decopilot" | "Claude Code" | "Codex"
  isLocal: boolean;         // drives bg-success/5 + "on this laptop" suffix
  tiers: Record<ChatTier, AgentTierEntry>;
}
```

Selection rules (mirror today's `computeAgentOptions`):

- Decopilot included iff `hasAnyKey === true`.
- Claude Code included iff `link.online && link.capabilities.includes("claude-code")`.
- Codex included iff `link.online && link.capabilities.includes("codex")`.

### Selection write path

Row click does both writes that today live on two different components:

```ts
function onRowSelect(section: AgentSection, tier: ChatTier) {
  const opt = optionForAgent(section.kind); // "decopilot" | "claude-code-laptop" | "codex-laptop"
  prefs.setPendingAgentOption(opt);
  prefs.setSimpleModeTier(tier);
  if (section.kind === "decopilot") {
    prefs.clearModel();
  } else {
    prefs.setModel({ modelId: section.tiers[tier].modelId!, keyId: undefined });
  }
  if (section.isLocal && currentBranch) {
    startVm.mutate({ virtualMcpId, branch: currentBranch, sandboxProviderKind: "remote-user" });
  }
  track("agent_model_selected", { agent: section.kind, tier });
}
```

### Component layout

```
apps/mesh/src/web/components/chat/
├── agent-model-trigger.tsx          UPDATED · closed pill, success styling when isLocal, gap fix
├── agent-model-popover.tsx          NEW · renders sections + lock state
├── select-model/
│   ├── agent-models.ts              UPDATED · adds Decopilot, exports getAgentSections
│   ├── agent-section.tsx            NEW · one section (header + 3 rows), handles isLocal styling
│   ├── decopilot.tsx                UNCHANGED · still mounted from settings page if applicable
│   ├── laptop-cli.tsx               DELETED · folded into agent-section.tsx
│   └── index.tsx                    UPDATED/DELETED · ModelSelectorBody no longer used in chat flow
└── pills/
    ├── agent-pill.tsx               DELETED
    ├── agent-options.ts             DELETED · rules move to agent-models.ts
    └── thread-pills.tsx             UPDATED · drops AgentPill; BranchPill unchanged
```

### Lock semantics wiring

`ThreadPills` already computes `isActive = (stream?.messages ?? []).length > 0` and reads `threadHarness`/`threadKind`. These move down into `AgentModelPopover` so the popover can disable non-active sections. The closed trigger's green styling reads from `(threadHarness ?? pendingHarnessId)` — correct in both locked and pending states.

## Edge cases

| Scenario | Behavior |
| --- | --- |
| No cloud keys, no laptop CLI | `NoAiProviderEmptyState` still owns the screen — popover never renders. |
| No cloud keys, laptop online (Claude Code only) | Only "Claude Code" section shows. |
| Cloud keys present, laptop offline | Only "Decopilot" section shows. |
| Thread active on Claude Code | Decopilot + Codex headers muted; Claude Code rows interactive. |
| User selects Decopilot row, empty thread | `setPendingAgentOption("decopilot")` + `setSimpleModeTier` + `clearModel()`. No eager VM start (cloud). |
| User selects Claude Code row, empty thread, branch picked | Above writes + `setModel({modelId, keyId: undefined})` + eager `startVm.mutate(...)`. |
| Laptop drops offline while popover open | `useCurrentLink` polls every 15s; next tick removes CLI sections via `getAgentSections`. |
| Trigger at narrow container width | `gap-0 @[496px]/chat-bottom:gap-1.5` removes phantom gap. |

## Testing

1. **`getAgentSections` unit tests** — table-driven over `(hasAnyKey, link.online, capabilities)`; asserts which sections appear and which carry `isLocal: true`.
2. **`AgentModelPopover` component tests** — render with mocked sections + `isActive`:
   - (a) only the active-thread section is interactive when locked,
   - (b) row click triggers the expected two-write sequence (verify via mocked prefs),
   - (c) `bg-success/5` lands on `isLocal` sections.
3. **`AgentModelTrigger` snapshot/behavior test** — assert (a) `text-success` only when resolved agent is CLI, (b) `gap-0` class present and `@[496px]/chat-bottom:gap-1.5` modifier present.

No e2e changes needed — message routing semantics didn't change.

## Removals

- `apps/mesh/src/web/components/chat/pills/agent-pill.tsx` — full file deleted.
- From `apps/mesh/src/web/components/chat/pills/agent-options.ts`: remove `decopilot-laptop` from `AgentOption` union and `AGENT_OPTION_PINS`; remove `computeAgentOptions`, `AGENT_OPTION_LABELS`, `AgentOptionsInput`, and the local `ORDER` array. Keep `AGENT_OPTION_PINS`, `pinsForOption`, `pinsToOption`, the `AgentOption` type itself, and the `AgentPins` interface.
- From `apps/mesh/src/web/components/chat/pills/thread-pills.tsx`: remove the AgentPill JSX, its imports, the `setPendingAgentOption` callback, the `useAiProviderKeys`/`useCurrentLink`/`useVmStart`/`startVm.mutate` plumbing (moves into the popover's row handler), and the surrounding `·` separator. `BranchPill` and its props stay.
- From `apps/mesh/src/web/components/chat/agent-model-trigger.tsx`: the `SimpleModeTierDropdown` fallback path goes away — the trigger always renders `AgentModelPopover` now.

What stays:

- `SimpleModeTierDropdown` (still used by `automation-detail.tsx`).
- `ModelSelectorBody` / `ModelSelectorStandaloneBody` / `LaptopCliModelSelectorBody` (still used by the settings page via the `ModelSelector` wrapper).
- `AGENT_OPTION_PINS`, `pinsForOption`, `pinsToOption` (still used by `chat-context.tsx`).
