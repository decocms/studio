# Project Chat Empty-State Pre-Input Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the branch chip + run-location choice out of the centered empty-state card and into a dedicated row above the chat input; reduce the in-input model pill to a tier-only control; tighten branch + git-tab gating to require an attached GitHub connection.

**Architecture:** UI-only refactor. New `ChatModeRow` (BranchPill + ModePicker) renders inside `<Chat.Footer>` above `<Chat.Input>`. Selector hooks (`useAgentMode`, `useChatTier`, `useTierSubtitle`) wrap the existing `pendingAgentOption`/`pendingTier` chat prefs so the new components don't reach into `AGENT_OPTION_PINS` directly. Submit-time wiring (`conn.submit({ harnessId, sandboxProviderKind, tier })`) is unchanged.

**Tech Stack:** React 19 (with React Compiler — no `useEffect`/`useMemo`/`useCallback`/`memo`), TypeScript, Tailwind v4 (design tokens enforced), Bun test runner, Biome formatter, shadcn UI primitives.

**Naming note (collision avoidance):** the existing `ChatPrefsContextValue` already exposes a `chatMode` field (interaction modes, values like `"default"`). The new selector is named **`useAgentMode` / `setAgentMode`** (location/harness mode, values `"cloud-decopilot" | "local-claude-code" | "local-codex"`). Do not name it `useChatMode`.

**Spec:** [`docs/superpowers/specs/2026-05-25-project-empty-state-pre-input-row-design.md`](../specs/2026-05-25-project-empty-state-pre-input-row-design.md)

---

## File structure

### New files

| Path | Responsibility |
|---|---|
| `apps/mesh/src/web/components/chat/use-agent-mode.ts` | Selector hooks over chat prefs: `useAgentMode`, `setAgentMode`, `useChatTier`, `setChatTier`, `useTierSubtitle`. Plus pure `agentOptionFromMode`/`agentModeFromOption` mapping for tests. |
| `apps/mesh/src/web/components/chat/use-agent-mode.test.ts` | Round-trip mode/option mapping; tier-subtitle resolution per mode. |
| `apps/mesh/src/web/components/chat/pills/mode-picker.tsx` | Closed pill + popover for the 3 mutually-exclusive modes. Greys (but keeps visible/selectable) CLIs missing from the link table. Fires `startVm.mutate` on local-mode select when a branch is set. Locked state matches `BranchPill`. |
| `apps/mesh/src/web/components/chat/pills/mode-picker.test.tsx` | Render order, greyed CLIs, click → `setAgentMode` + close, `startVm` eager fire, locked state. |
| `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx` | Composite: BranchPill (conditional on connected github) + ModePicker. Whole row gated on `agentHasClonableSource`. Inherits `locked` from chat stream. |
| `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx` | Null when not clonable; ModePicker-only for template agents; BranchPill+ModePicker for connected; `locked` propagation. |
| `apps/mesh/src/web/components/chat/tier-trigger.tsx` | Tier-only pill + popover (Fast/Smart/Thinking). Subtitle = `useTierSubtitle(mode, tier)`. Closed pill shows tier name only (collapses to single letter at `@[496px]/chat-bottom`). |
| `apps/mesh/src/web/components/chat/tier-trigger.test.tsx` | Closed pill renders tier name only; popover subtitles re-resolve when mode changes; click → `setChatTier` + close. |

### Modified files

| Path | Change |
|---|---|
| `apps/mesh/src/web/lib/agent-capabilities.ts` | Add `agentHasConnectedGithub(virtualMcp)` predicate (one-liner over `getActiveGithubRepo`). |
| `apps/mesh/src/web/lib/agent-capabilities.test.ts` | Add cases for `agentHasConnectedGithub`. |
| `apps/mesh/src/web/components/chat/input.tsx` | Replace `<AgentModelTrigger .../>` with `<TierTrigger .../>` (lines around 35 import + 597-604 JSX). |
| `apps/mesh/src/web/components/chat/side-panel-chat.tsx` | Drop `{showBranchPicker && <ThreadPills/>}` block from `SidebarEmptyState`; insert `<ChatModeRow/>` as the first child of `<Chat.Footer>` on both branches of the `isChatEmpty` conditional in `ChatPanelContent`. |
| `apps/mesh/src/web/layouts/main-panel-tabs/use-main-panel-tabs.ts` | Switch the `hasActiveGithubRepo` derivation from `getActiveGithubRepo(...)` truthiness to `agentHasConnectedGithub(...)`. |

### Deleted files (Task 10, with grep-verify before each `rm`)

- `apps/mesh/src/web/components/chat/pills/thread-pills.tsx`
- `apps/mesh/src/web/components/chat/agent-model-trigger.tsx`
- `apps/mesh/src/web/components/chat/agent-model-popover.tsx`
- `apps/mesh/src/web/components/chat/select-model/agent-models.tsx`
- `apps/mesh/src/web/components/chat/select-model/agent-section.tsx`
- `apps/mesh/src/web/components/chat/select-model/desktop-cli.tsx`

---

## Task 1: `agentHasConnectedGithub` predicate

**Files:**
- Modify: `apps/mesh/src/web/lib/agent-capabilities.ts`
- Test: `apps/mesh/src/web/lib/agent-capabilities.test.ts`

- [ ] **Step 1: Add failing tests for `agentHasConnectedGithub`**

Append to `apps/mesh/src/web/lib/agent-capabilities.test.ts` (after the existing `agentHasClonableSource` describe block, before `describe("hasLocalCliHarness")`):

```ts
describe("agentHasConnectedGithub", () => {
  it("returns false for null/undefined virtualMcp", () => {
    expect(agentHasConnectedGithub(null)).toBe(false);
    expect(agentHasConnectedGithub(undefined)).toBe(false);
  });

  it("returns false for a Start Website agent (no connectionId)", () => {
    const vm = {
      connections: [],
      metadata: {
        githubRepo: {
          url: "https://github.com/decocms/webapp-template",
          owner: "decocms",
          name: "webapp-template",
        },
      },
    } as any;
    expect(agentHasConnectedGithub(vm)).toBe(false);
  });

  it("returns false when connectionId is set but the connection is detached", () => {
    const vm = {
      connections: [{ connection_id: "conn_other" }],
      metadata: {
        githubRepo: {
          url: "https://github.com/acme/app",
          owner: "acme",
          name: "app",
          connectionId: "conn_github",
        },
      },
    } as any;
    expect(agentHasConnectedGithub(vm)).toBe(false);
  });

  it("returns true when connectionId is set and the connection is attached", () => {
    const vm = {
      connections: [{ connection_id: "conn_github" }],
      metadata: {
        githubRepo: {
          url: "https://github.com/acme/app",
          owner: "acme",
          name: "app",
          connectionId: "conn_github",
        },
      },
    } as any;
    expect(agentHasConnectedGithub(vm)).toBe(true);
  });
});
```

And update the import at the top of the file to include the new symbol:

```ts
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
  hasLocalCliHarness,
} from "./agent-capabilities";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/web/lib/agent-capabilities.test.ts`
Expected: 4 failures with "agentHasConnectedGithub is not a function" (or similar).

- [ ] **Step 3: Add the predicate**

Modify `apps/mesh/src/web/lib/agent-capabilities.ts`. After the `agentHasClonableSource` function (around line 22), add:

```ts
import { getActiveGithubRepo } from "./github-repo";
import type { VirtualMCPEntity } from "@decocms/mesh-sdk/types";

/**
 * True only when the virtual MCP has a GitHub repo with an attached
 * connection (i.e. authenticated github identity, not a public-clone
 * template). Gate the BranchPill and the git tab on this predicate.
 *
 * Built on top of `getActiveGithubRepo`, which already returns null
 * when a stale connectionId references a detached connection.
 */
export function agentHasConnectedGithub(
  virtualMcp: VirtualMCPEntity | null | undefined,
): boolean {
  return !!getActiveGithubRepo(virtualMcp ?? null)?.connectionId;
}
```

If the file does not already import from `./github-repo` and `@decocms/mesh-sdk/types`, add the imports at the top of the file (preserve any existing imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/web/lib/agent-capabilities.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/lib/agent-capabilities.ts apps/mesh/src/web/lib/agent-capabilities.test.ts
git commit -m "feat(chat): add agentHasConnectedGithub predicate"
```

---

## Task 2: `use-agent-mode` selector hooks

**Files:**
- Create: `apps/mesh/src/web/components/chat/use-agent-mode.ts`
- Test: `apps/mesh/src/web/components/chat/use-agent-mode.test.ts`

- [ ] **Step 1: Write failing tests for the pure mapping**

Create `apps/mesh/src/web/components/chat/use-agent-mode.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  agentModeFromOption,
  agentOptionFromMode,
  type AgentMode,
} from "./use-agent-mode";

describe("agentOptionFromMode <-> agentModeFromOption", () => {
  const cases: Array<[AgentMode, "decopilot" | "claude-code-desktop" | "codex-desktop"]> = [
    ["cloud-decopilot", "decopilot"],
    ["local-claude-code", "claude-code-desktop"],
    ["local-codex", "codex-desktop"],
  ];

  for (const [mode, option] of cases) {
    it(`maps ${mode} <-> ${option}`, () => {
      expect(agentOptionFromMode(mode)).toBe(option);
      expect(agentModeFromOption(option)).toBe(mode);
    });
  }

  it("agentModeFromOption(null) defaults to cloud-decopilot", () => {
    expect(agentModeFromOption(null)).toBe("cloud-decopilot");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/web/components/chat/use-agent-mode.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Create `use-agent-mode.ts` with the pure mappings and the selector hooks**

Create `apps/mesh/src/web/components/chat/use-agent-mode.ts`:

```ts
import type { ChatTier } from "@/tools/organization/schema";
import {
  useAiProviderKeys,
  useAiProviderModels,
} from "@/web/hooks/collections/use-ai-providers";
import { useSimpleMode } from "@/web/hooks/use-organization-settings";
import { pickSimpleModeDefaults } from "@decocms/mesh-sdk";
import { resolveAgentTier } from "@/ai-providers/agent-tiers";
import { useChatPrefs } from "./context";
import type { AgentOption } from "./pills/agent-options";

/**
 * The (location, harness) mode the chat input is bound to. Mutually
 * exclusive — one of these three values is always the answer.
 *
 * Named `AgentMode` (not `ChatMode`) to avoid colliding with
 * `ChatPrefsContextValue.chatMode`, which is a different concept
 * (interaction mode: "default" | ...).
 */
export type AgentMode = "cloud-decopilot" | "local-claude-code" | "local-codex";

const MODE_TO_OPTION: Record<AgentMode, AgentOption> = {
  "cloud-decopilot": "decopilot",
  "local-claude-code": "claude-code-desktop",
  "local-codex": "codex-desktop",
};

const OPTION_TO_MODE: Record<AgentOption, AgentMode> = {
  decopilot: "cloud-decopilot",
  "claude-code-desktop": "local-claude-code",
  "codex-desktop": "local-codex",
};

export function agentOptionFromMode(mode: AgentMode): AgentOption {
  return MODE_TO_OPTION[mode];
}

export function agentModeFromOption(option: AgentOption | null): AgentMode {
  if (option === null) return "cloud-decopilot";
  return OPTION_TO_MODE[option];
}

/** Current agent mode derived from the persisted pending option. */
export function useAgentMode(): AgentMode {
  const { pendingAgentOption } = useChatPrefs();
  return agentModeFromOption(pendingAgentOption);
}

/** Persist a new agent mode (writes through to `pendingAgentOption`). */
export function useSetAgentMode(): (mode: AgentMode) => void {
  const { setPendingAgentOption } = useChatPrefs();
  return (mode: AgentMode) => setPendingAgentOption(agentOptionFromMode(mode));
}

/** Current chat tier from prefs. Defaults to "smart" via prefs. */
export function useChatTier(): ChatTier {
  return useChatPrefs().simpleModeTier;
}

export function useSetChatTier(): (tier: ChatTier) => void {
  return useChatPrefs().setSimpleModeTier;
}

/**
 * Mirror of server-side `resolveTier` for label-display purposes.
 *
 * - Cloud (Decopilot): reads `org_settings.simple_mode.tiers[tier]`;
 *   falls back to `pickSimpleModeDefaults` over connected providers.
 * - Local (Claude Code / Codex): reads `resolveAgentTier(harness, tier)`
 *   from the server-safe `ai-providers/agent-tiers.ts`.
 *
 * Returns `null` when nothing is resolvable — the popover row stays
 * selectable; server surfaces `TierUnavailableError` at send time.
 */
export function useTierSubtitle(
  mode: AgentMode,
  tier: ChatTier,
): string | null {
  const simple = useSimpleMode();
  const keys = useAiProviderKeys();
  // Pass the active simple-mode slot's keyId for cache reuse; nothing
  // breaks when it's null (returns an empty model list).
  const slotKeyId = simple.tiers[tier]?.keyId;
  const { models: slotModels } = useAiProviderModels(slotKeyId);

  if (mode === "local-claude-code") {
    return resolveAgentTier("claude-code", tier)?.label ?? null;
  }
  if (mode === "local-codex") {
    return resolveAgentTier("codex", tier)?.label ?? null;
  }

  // mode === "cloud-decopilot"
  const slot = simple.tiers[tier];
  if (slot) return slot.title ?? slot.modelId;

  if (keys.length === 0 || !slotKeyId) return null;

  // Fallback: replicate pickSimpleModeDefaults over the active slot's
  // key. This matches what the server picks when the slot is unset
  // and the effective key is also the first match for the tier.
  const defaults = pickSimpleModeDefaults(
    keys.map((k) => ({
      id: k.id,
      providerId: k.providerId,
      label: k.label,
      presetId: k.presetId,
      createdBy: k.createdBy,
      createdAt: k.createdAt,
    })),
    { [slotKeyId]: slotModels },
  );
  const pick =
    tier === "fast"
      ? defaults.chat.fast
      : tier === "thinking"
        ? defaults.chat.thinking
        : defaults.chat.smart;
  return pick?.title ?? pick?.modelId ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/web/components/chat/use-agent-mode.test.ts`
Expected: all 4 mapping tests pass.

- [ ] **Step 5: Type-check the new file**

Run: `bun run check`
Expected: passes. If imports fail (e.g. `@/ai-providers/agent-tiers` path), check the existing import in `apps/mesh/src/api/routes/decopilot/routes.ts:11` for the canonical form and adjust.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/use-agent-mode.ts apps/mesh/src/web/components/chat/use-agent-mode.test.ts
git commit -m "feat(chat): add use-agent-mode selector hooks"
```

---

## Task 3: `ModePicker` component

**Files:**
- Create: `apps/mesh/src/web/components/chat/pills/mode-picker.tsx`
- Test: `apps/mesh/src/web/components/chat/pills/mode-picker.test.tsx`

The component follows the today's `AgentModelTrigger` pattern of a pure inner variant + a smart wrapper so tests do not need to mock the whole chat context.

- [ ] **Step 1: Write failing tests for `ModePickerPure`**

Create `apps/mesh/src/web/components/chat/pills/mode-picker.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModePickerPure } from "./mode-picker";

describe("ModePickerPure", () => {
  it("renders the closed pill with the current mode label", () => {
    render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /Cloud/i })).toBeInTheDocument();
  });

  it("renders Claude Code label when active", () => {
    render(
      <ModePickerPure
        mode="local-claude-code"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Claude Code/i }),
    ).toBeInTheDocument();
  });

  it("locked state renders a span, not a button", () => {
    render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={true}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Cloud/)).toBeInTheDocument();
  });

  it("opens the popover and shows all three rows in order", () => {
    render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cloud/i }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Decopilot/),
      expect.stringMatching(/Claude Code/),
      expect.stringMatching(/Codex/),
    ]);
  });

  it("greys unavailable CLIs but keeps them selectable", () => {
    render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: false, codex: false }}
        locked={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cloud/i }));
    const cc = screen.getByRole("menuitem", { name: /Claude Code/ });
    const codex = screen.getByRole("menuitem", { name: /Codex/ });
    expect(cc).toHaveAttribute("data-available", "false");
    expect(codex).toHaveAttribute("data-available", "false");
    expect(cc).not.toBeDisabled();
    expect(codex).not.toBeDisabled();
  });

  it("calls onSelect with the right mode and closes on click", () => {
    const onSelect = mock(() => {});
    render(
      <ModePickerPure
        mode="cloud-decopilot"
        availability={{ claudeCode: true, codex: true }}
        locked={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cloud/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Claude Code/ }));
    expect(onSelect).toHaveBeenCalledWith("local-claude-code");
    // Popover closes ⇒ menuitems unmount
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/web/components/chat/pills/mode-picker.test.tsx`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement `ModePickerPure` + smart wrapper**

Create `apps/mesh/src/web/components/chat/pills/mode-picker.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Cloud01, Monitor01, ChevronDown, Check } from "@untitledui/icons";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useSandboxStart } from "@/web/components/sandbox/hooks/use-sandbox-start";
import {
  type AgentMode,
  useAgentMode,
  useSetAgentMode,
} from "../use-agent-mode";

export interface ModePickerAvailability {
  claudeCode: boolean;
  codex: boolean;
}

interface PureProps {
  mode: AgentMode;
  availability: ModePickerAvailability;
  locked: boolean;
  onSelect: (mode: AgentMode) => void;
}

interface ModeRow {
  mode: AgentMode;
  label: string;
  group: "cloud" | "local";
  icon: React.ReactNode;
  isAvailable: (a: ModePickerAvailability) => boolean;
}

const ROWS: ModeRow[] = [
  {
    mode: "cloud-decopilot",
    label: "Decopilot",
    group: "cloud",
    icon: <Cloud01 size={14} />,
    isAvailable: () => true,
  },
  {
    mode: "local-claude-code",
    label: "Claude Code",
    group: "local",
    icon: <Monitor01 size={14} />,
    isAvailable: (a) => a.claudeCode,
  },
  {
    mode: "local-codex",
    label: "Codex",
    group: "local",
    icon: <Monitor01 size={14} />,
    isAvailable: (a) => a.codex,
  },
];

function pillLabel(mode: AgentMode): { icon: React.ReactNode; text: string } {
  if (mode === "local-claude-code")
    return { icon: <Monitor01 size={14} />, text: "Claude Code" };
  if (mode === "local-codex")
    return { icon: <Monitor01 size={14} />, text: "Codex" };
  return { icon: <Cloud01 size={14} />, text: "Cloud" };
}

const baseClasses =
  "gap-1.5 text-muted-foreground hover:text-foreground text-xs";
const localActiveClasses =
  "text-success bg-success/10 hover:text-success hover:bg-success/20";

/**
 * Stateless variant — no hooks. Used by tests and by the smart wrapper.
 * Renders the closed pill + the popover with three sectioned rows.
 */
export function ModePickerPure({
  mode,
  availability,
  locked,
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);
  const { icon, text } = pillLabel(mode);
  const isLocal = mode !== "cloud-decopilot";

  if (locked) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-muted text-xs",
          isLocal ? "text-success" : "text-muted-foreground",
        )}
        title="Fixed for this thread"
      >
        {icon}
        {text}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={text}
          className={cn(baseClasses, isLocal && localActiveClasses)}
        >
          {icon}
          <span>{text}</span>
          <ChevronDown size={12} className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-1 w-64">
        <div role="menu" className="flex flex-col">
          <Section title="Cloud" />
          <Row
            row={ROWS[0]}
            active={mode === ROWS[0].mode}
            available={ROWS[0].isAvailable(availability)}
            onSelect={(m) => {
              onSelect(m);
              setOpen(false);
            }}
          />
          <Section title="Local" />
          <Row
            row={ROWS[1]}
            active={mode === ROWS[1].mode}
            available={ROWS[1].isAvailable(availability)}
            onSelect={(m) => {
              onSelect(m);
              setOpen(false);
            }}
          />
          <Row
            row={ROWS[2]}
            active={mode === ROWS[2].mode}
            available={ROWS[2].isAvailable(availability)}
            onSelect={(m) => {
              onSelect(m);
              setOpen(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {title}
    </div>
  );
}

function Row({
  row,
  active,
  available,
  onSelect,
}: {
  row: ModeRow;
  active: boolean;
  available: boolean;
  onSelect: (mode: AgentMode) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-available={available}
      onClick={() => onSelect(row.mode)}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left",
        "hover:bg-muted",
        !available && "opacity-60",
      )}
    >
      <span className="shrink-0">{row.icon}</span>
      <span className="flex-1">{row.label}</span>
      {!available && (
        <span className="text-xs text-muted-foreground">Not connected</span>
      )}
      {active && <Check size={14} className="text-foreground" />}
    </button>
  );
}

interface SmartProps {
  locked: boolean;
  /** Branch the user picked; null when no branch concept exists for this
   *  agent (template-cloned). Drives the eager VM start. */
  currentBranch: string | null;
  /** The virtual MCP id used by the eager VM start. */
  virtualMcpId: string;
}

/**
 * Smart wrapper used by `ChatModeRow`. Reads agent-mode + link
 * capabilities, writes via `useSetAgentMode`, and fires the eager VM
 * start for local modes when a branch is present.
 */
export function ModePicker({ locked, currentBranch, virtualMcpId }: SmartProps) {
  const mode = useAgentMode();
  const setAgentMode = useSetAgentMode();
  const link = useCurrentLink();
  const { org } = useProjectContext();
  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useSandboxStart(mcpClient);

  const availability: ModePickerAvailability = {
    claudeCode: link.online && link.capabilities.includes("claude-code"),
    codex: link.online && link.capabilities.includes("codex"),
  };

  const handleSelect = (next: AgentMode) => {
    setAgentMode(next);
    if (next !== "cloud-decopilot" && currentBranch) {
      startVm.mutate({
        virtualMcpId,
        branch: currentBranch,
        sandboxProviderKind: "user-desktop" as const,
      });
    }
  };

  return (
    <ModePickerPure
      mode={mode}
      availability={availability}
      locked={locked}
      onSelect={handleSelect}
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/web/components/chat/pills/mode-picker.test.tsx`
Expected: all 6 tests pass.

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: passes. If icons (`Cloud01`, `Monitor01`) are not in `@untitledui/icons`, substitute the closest available icon — grep the existing chat folder for `from "@untitledui/icons"` to see what's in use.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/pills/mode-picker.tsx apps/mesh/src/web/components/chat/pills/mode-picker.test.tsx
git commit -m "feat(chat): add ModePicker pill (Cloud / Local CC / Local Codex)"
```

---

## Task 4: `TierTrigger` component

**Files:**
- Create: `apps/mesh/src/web/components/chat/tier-trigger.tsx`
- Test: `apps/mesh/src/web/components/chat/tier-trigger.test.tsx`

- [ ] **Step 1: Write failing tests for `TierTriggerPure`**

Create `apps/mesh/src/web/components/chat/tier-trigger.test.tsx`:

```tsx
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TierTriggerPure } from "./tier-trigger";

describe("TierTriggerPure", () => {
  const subtitleFor = (tier: "fast" | "smart" | "thinking") =>
    ({ fast: "Haiku", smart: "Sonnet", thinking: "Opus" })[tier];

  it("closed pill shows tier name only", () => {
    render(
      <TierTriggerPure tier="smart" subtitleFor={subtitleFor} onSelect={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /Smart/i })).toBeInTheDocument();
    expect(screen.queryByText(/Sonnet/)).toBeNull();
  });

  it("popover shows three rows with subtitle from subtitleFor", () => {
    render(
      <TierTriggerPure tier="smart" subtitleFor={subtitleFor} onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Smart/i }));
    expect(screen.getByRole("menuitem", { name: /Fast/ })).toHaveTextContent(
      "Haiku",
    );
    expect(screen.getByRole("menuitem", { name: /Smart/ })).toHaveTextContent(
      "Sonnet",
    );
    expect(
      screen.getByRole("menuitem", { name: /Thinking/ }),
    ).toHaveTextContent("Opus");
  });

  it("hides the subtitle line when subtitleFor returns null", () => {
    render(
      <TierTriggerPure
        tier="smart"
        subtitleFor={() => null}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Smart/i }));
    // Rows are still selectable, just no subtitle text
    expect(screen.getAllByRole("menuitem").length).toBe(3);
  });

  it("calls onSelect and closes when a row is clicked", () => {
    const onSelect = mock(() => {});
    render(
      <TierTriggerPure tier="smart" subtitleFor={subtitleFor} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Smart/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Thinking/ }));
    expect(onSelect).toHaveBeenCalledWith("thinking");
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/web/components/chat/tier-trigger.test.tsx`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement `TierTriggerPure` + smart wrapper**

Create `apps/mesh/src/web/components/chat/tier-trigger.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronDown, Check } from "@untitledui/icons";
import type { ChatTier } from "@/tools/organization/schema";
import {
  useAgentMode,
  useChatTier,
  useSetChatTier,
  useTierSubtitle,
} from "./use-agent-mode";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];
const TIER_LABELS: Record<ChatTier, string> = {
  fast: "Fast",
  smart: "Smart",
  thinking: "Thinking",
};
const TIER_SHORT: Record<ChatTier, string> = {
  fast: "F",
  smart: "S",
  thinking: "T",
};

interface PureProps {
  tier: ChatTier;
  subtitleFor: (tier: ChatTier) => string | null;
  onSelect: (tier: ChatTier) => void;
}

/**
 * Stateless variant — no hooks. Used by tests and by the smart wrapper.
 * Closed pill shows the tier label only; popover shows three rows with
 * the subtitle resolved via the injected `subtitleFor`.
 */
export function TierTriggerPure({ tier, subtitleFor, onSelect }: PureProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={TIER_LABELS[tier]}
          className="gap-0 @[496px]/chat-bottom:gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className="inline-block @[496px]/chat-bottom:hidden">
            {TIER_SHORT[tier]}
          </span>
          <span className="hidden @[496px]/chat-bottom:inline">
            {TIER_LABELS[tier]}
          </span>
          <ChevronDown size={12} className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-1 w-56">
        <div role="menu" className="flex flex-col">
          {TIER_ORDER.map((t) => {
            const subtitle = subtitleFor(t);
            const active = t === tier;
            return (
              <button
                key={t}
                type="button"
                role="menuitem"
                aria-label={TIER_LABELS[t]}
                onClick={() => {
                  onSelect(t);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2 px-2 py-1.5 rounded-md text-left",
                  "hover:bg-muted",
                )}
              >
                <div className="flex-1">
                  <div className="text-sm">{TIER_LABELS[t]}</div>
                  {subtitle && (
                    <div className="text-xs text-muted-foreground">
                      {subtitle}
                    </div>
                  )}
                </div>
                {active && <Check size={14} className="text-foreground mt-0.5" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Smart wrapper used by `Chat.Input`. Reads current tier + mode, builds
 * the per-tier subtitle resolver, and writes through `useSetChatTier`.
 */
export function TierTrigger() {
  const tier = useChatTier();
  const setTier = useSetChatTier();
  const mode = useAgentMode();

  // Resolve subtitles at popover-open time. Calling `useTierSubtitle`
  // for each tier here is fine — it's three hook calls, all backed by
  // React Query caches.
  const fast = useTierSubtitle(mode, "fast");
  const smart = useTierSubtitle(mode, "smart");
  const thinking = useTierSubtitle(mode, "thinking");

  const subtitleFor = (t: ChatTier): string | null => {
    if (t === "fast") return fast;
    if (t === "thinking") return thinking;
    return smart;
  };

  return <TierTriggerPure tier={tier} subtitleFor={subtitleFor} onSelect={setTier} />;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/web/components/chat/tier-trigger.test.tsx`
Expected: all 4 tests pass.

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/tier-trigger.tsx apps/mesh/src/web/components/chat/tier-trigger.test.tsx
git commit -m "feat(chat): add TierTrigger (Fast/Smart/Thinking pill)"
```

---

## Task 5: `ChatModeRow` composite

**Files:**
- Create: `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx`
- Test: `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`

- [ ] **Step 1: Write failing tests for `ChatModeRowPure`**

Create `apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`:

```tsx
import { describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ChatModeRowPure } from "./chat-mode-row";

describe("ChatModeRowPure", () => {
  it("returns null when virtual MCP is not clonable", () => {
    const { container } = render(
      <ChatModeRowPure
        clonable={false}
        connected={false}
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders ModePicker only when clonable but not connected (template)", () => {
    render(
      <ChatModeRowPure
        clonable={true}
        connected={false}
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(screen.queryByTestId("branch-pill")).toBeNull();
    expect(screen.getByTestId("mode-picker")).toBeInTheDocument();
  });

  it("renders BranchPill + ModePicker when connected", () => {
    render(
      <ChatModeRowPure
        clonable={true}
        connected={true}
        branchPill={<span data-testid="branch-pill">branch</span>}
        modePicker={<span data-testid="mode-picker">mode</span>}
      />,
    );
    expect(screen.getByTestId("branch-pill")).toBeInTheDocument();
    expect(screen.getByTestId("mode-picker")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement `ChatModeRow` + pure variant**

Create `apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx`:

```tsx
import type { ReactNode } from "react";
import type { SandboxMap, VirtualMCPEntity } from "@decocms/mesh-sdk/types";
import {
  agentHasClonableSource,
  agentHasConnectedGithub,
} from "@/web/lib/agent-capabilities";
import { useOptionalChatStream } from "../context";
import { BranchPill } from "./branch-pill";
import { ModePicker } from "./mode-picker";

interface PureProps {
  clonable: boolean;
  connected: boolean;
  branchPill: ReactNode;
  modePicker: ReactNode;
}

/**
 * Stateless layout — used by tests. Returns null when not clonable;
 * hides the branch pill for template-cloned agents (not `connected`).
 * `locked` is owned by the children — the row layout itself doesn't
 * care about it.
 */
export function ChatModeRowPure({
  clonable,
  connected,
  branchPill,
  modePicker,
}: PureProps) {
  if (!clonable) return null;
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-xs">
      {connected && branchPill}
      {modePicker}
    </div>
  );
}

interface SmartProps {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcp: VirtualMCPEntity | null | undefined;
  sandboxMap: SandboxMap | undefined;
  currentBranch: string | null;
  onBranchChange: (branch: string) => void;
}

/**
 * Smart wrapper. Composes BranchPill (when connected github) and the
 * ModePicker. Whole row is gated on `agentHasClonableSource`. Locking
 * is inherited from the chat stream (matches today's BranchPill).
 */
export function ChatModeRow({
  orgId,
  orgSlug,
  userId,
  virtualMcp,
  sandboxMap,
  currentBranch,
  onBranchChange,
}: SmartProps) {
  const stream = useOptionalChatStream();
  const locked = (stream?.messages ?? []).length > 0;

  const clonable = agentHasClonableSource(virtualMcp?.metadata);
  const connected = agentHasConnectedGithub(virtualMcp);
  const githubRepo = virtualMcp?.metadata?.githubRepo ?? null;

  return (
    <ChatModeRowPure
      clonable={clonable}
      connected={connected}
      locked={locked}
      branchPill={
        <BranchPill
          orgId={orgId}
          orgSlug={orgSlug}
          userId={userId}
          virtualMcpId={virtualMcp?.id ?? ""}
          connectionId={githubRepo?.connectionId ?? ""}
          owner={githubRepo?.owner ?? ""}
          repo={githubRepo?.name ?? ""}
          sandboxMap={sandboxMap}
          value={currentBranch}
          onChange={onBranchChange}
          locked={locked}
        />
      }
      modePicker={
        <ModePicker
          locked={locked}
          currentBranch={currentBranch}
          virtualMcpId={virtualMcp?.id ?? ""}
        />
      }
    />
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx`
Expected: all 3 tests pass.

- [ ] **Step 5: Type-check**

Run: `bun run check`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/pills/chat-mode-row.tsx apps/mesh/src/web/components/chat/pills/chat-mode-row.test.tsx
git commit -m "feat(chat): add ChatModeRow (BranchPill + ModePicker composite)"
```

---

## Task 6: Wire `TierTrigger` into `Chat.Input`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/input.tsx`

- [ ] **Step 1: Read the current AgentModelTrigger call-site to confirm what it consumes**

Run: `bun run check` first to confirm we're starting from a clean state.

The current call-site is `apps/mesh/src/web/components/chat/input.tsx:597-604`:

```tsx
<AgentModelTrigger
  agent={pendingHarnessId}
  sandboxKind={pendingSandboxProviderKind}
  tier={simpleModeTier}
  currentBranch={taskCtx?.currentBranch ?? null}
  virtualMcpId={selectedVirtualMcp?.id ?? decopilotId}
  onSelect={setSimpleModeTier}
/>
```

The new `TierTrigger` reads tier from `useChatTier()` and writes via `useSetChatTier()`, so the call-site collapses to a self-contained component.

- [ ] **Step 2: Replace the import**

In `apps/mesh/src/web/components/chat/input.tsx`, around line 35:

```ts
// REMOVE
import { AgentModelTrigger } from "./agent-model-trigger";

// ADD
import { TierTrigger } from "./tier-trigger";
```

- [ ] **Step 3: Replace the JSX**

In `apps/mesh/src/web/components/chat/input.tsx:597-604`, replace the `<AgentModelTrigger .../>` block with:

```tsx
<TierTrigger />
```

- [ ] **Step 4: Clean up now-unused destructured prefs**

In `apps/mesh/src/web/components/chat/input.tsx:240-252`, the `useChatPrefs()` destructure still includes `simpleModeTier` and `setSimpleModeTier`. They may still be used elsewhere in the file — keep them if so. `pendingHarnessId` and `pendingSandboxProviderKind` are only consumed by the removed JSX block; if grep confirms no other usage in the file, remove them from the destructure.

Run: `bun run check`
Expected: passes; if "is declared but never used" errors fire for the removed fields, prune them from the destructure.

- [ ] **Step 5: Run any existing input tests**

Run: `bun test apps/mesh/src/web/components/chat/input` (will glob to whatever test files exist; skip if none).
Expected: passes.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/input.tsx
git commit -m "refactor(chat): use TierTrigger for the in-input model pill"
```

---

## Task 7: Insert `ChatModeRow` and remove the branch chip from the centered card

**Files:**
- Modify: `apps/mesh/src/web/components/chat/side-panel-chat.tsx`

- [ ] **Step 1: Drop `ThreadPills` from `SidebarEmptyState`**

In `apps/mesh/src/web/components/chat/side-panel-chat.tsx`, remove:

- The `import { ThreadPills } from "./pills/thread-pills";` line (around line 17).
- The whole `{showBranchPicker && (<div className="mt-2"><ThreadPills ... /></div>)}` block (around lines 69-86 inside `SidebarEmptyState`).
- The now-unused locals computed only for `ThreadPills`: `githubRepo`, `showBranchPicker`, `threadKind`, `threadHarness`, the `useChatTask` destructure of `setCurrentTaskBranch` if no longer used, and the `SandboxProviderKind` / `HarnessId` type imports if no longer referenced.

Keep `useChatTask`'s `activeTask` and `currentBranch` only if they're still used after this change — they will be consumed by `ChatModeRow` via `currentBranch` in Step 2.

- [ ] **Step 2: Insert `ChatModeRow` in `ChatPanelContent`'s `<Chat.Footer>`**

Add the import at the top of the file:

```ts
import { ChatModeRow } from "./pills/chat-mode-row";
```

Find the two `<Chat.Footer>` blocks in `ChatPanelContent` (around lines 157-161 and 168-172 — both currently wrap `<Chat.Input .../>`). Replace each with the row inserted as the first child:

```tsx
<Chat.Footer>
  <ChatModeRow
    orgId={org.id}
    orgSlug={org.slug}
    userId={userId}
    virtualMcp={fullVm}
    sandboxMap={fullVm?.metadata?.sandboxMap}
    currentBranch={currentBranch}
    onBranchChange={setCurrentTaskBranch}
  />
  <Chat.Input
    onOpenContextPanel={() => setActivePanel("context")}
  />
</Chat.Footer>
```

`ChatPanelContent` needs `userId`, `currentBranch`, and `setCurrentTaskBranch` in scope. Read the function to confirm they exist; pull them in via `authClient.useSession()` / `useChatTask()` matching the patterns already used in `SidebarEmptyState`. Add the `useChatTask` import if missing.

- [ ] **Step 3: Verify type-check + tests**

Run: `bun run check`
Expected: passes.

Run: `bun test apps/mesh/src/web/components/chat/`
Expected: passes (existing tests + the new ones).

- [ ] **Step 4: Manual UI smoke check**

Run: `bun run dev`
Open the app and visit:
- A connected-github virtual MCP — confirm `⎇ <branch> ⌄  ☁ Cloud ⌄` row appears above the input, and the centered card no longer has a branch chip.
- A template-cloned ("Start Website") virtual MCP — confirm only the mode picker appears (no branch pill), and the centered card no longer has a branch chip.

If the dev server is already running from a prior task, no restart needed.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/side-panel-chat.tsx
git commit -m "feat(chat): render ChatModeRow above the input on project chats"
```

---

## Task 8: Tighten git-tab gating

**Files:**
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/use-main-panel-tabs.ts`

- [ ] **Step 1: Locate the `hasActiveGithubRepo` derivation**

Read `apps/mesh/src/web/layouts/main-panel-tabs/use-main-panel-tabs.ts` and find where `hasActiveGithubRepo` is computed (around the same area that uses `getActiveGithubRepo` — confirmed at line 24 import). It will be a `Boolean(getActiveGithubRepo(...))`-style expression. The result gates Preview + git tabs at lines 177-180:

```ts
if (hasActiveGithubRepo) {
  systemTabs.push({ id: "preview", title: "Preview" });
  systemTabs.push({ id: "git", title: currentBranch ?? "git" });
}
```

- [ ] **Step 2: Switch to `agentHasConnectedGithub`**

Replace the derivation. At the import block, add (preserving existing imports):

```ts
import { agentHasConnectedGithub } from "@/web/lib/agent-capabilities";
```

Replace the `hasActiveGithubRepo` computation with `agentHasConnectedGithub(virtualMcp)`, where `virtualMcp` is whatever local variable the file already uses for the active VM entity (likely from `useVirtualMCP(...)`). Read the surrounding code to use the right local name; do NOT introduce a new variable.

Keep `getActiveGithubRepo` import only if other code in the file still uses it (the `currentBranch` resolution may). If no longer used, remove the import.

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: passes.

- [ ] **Step 4: Manual UI smoke check**

Run: `bun run dev`
- Visit a connected-github virtual MCP — Preview + git tabs still appear.
- Visit a template-cloned virtual MCP — Preview + git tabs are GONE; only Settings + Automations.

- [ ] **Step 5: Commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/main-panel-tabs/use-main-panel-tabs.ts
git commit -m "fix(layout): hide Preview+git tabs for template-cloned agents"
```

---

## Task 9: Audit other `getActiveGithubRepo` call-sites

**Files (read-only audit + selective edits):**
- `apps/mesh/src/web/views/virtual-mcp/header-info.tsx`
- `apps/mesh/src/web/components/thread/github/header-actions.tsx`
- `apps/mesh/src/web/components/thread/github/git-tab.tsx`

- [ ] **Step 1: Audit `header-info.tsx`**

Run: `bun run check && grep -n "getActiveGithubRepo" apps/mesh/src/web/views/virtual-mcp/header-info.tsx`

Read each usage and decide:
- **Display-only "cloned from <repo>" reference** → keep `getActiveGithubRepo` (the loose check is correct; we want to surface template-cloned repos too).
- **Anything that implies push/pull, branch interaction, or assumes a real github identity** → switch to `agentHasConnectedGithub`.

Document the decision in the commit message even if no change.

- [ ] **Step 2: Audit `header-actions.tsx`**

Run: `grep -n "getActiveGithubRepo\|githubRepo" apps/mesh/src/web/components/thread/github/header-actions.tsx`

Apply the same decision matrix as Step 1. This file is more likely to need the strict predicate (actions usually require a real connection).

- [ ] **Step 3: Audit `git-tab.tsx`**

Run: `grep -n "getActiveGithubRepo\|githubRepo" apps/mesh/src/web/components/thread/github/git-tab.tsx`

The tab is gated by the parent (`use-main-panel-tabs.ts`, already tightened in Task 8), so internal references to the repo can remain loose (the tab won't render for template agents). But if the tab's render path branches on `connectionId`, leave it alone.

- [ ] **Step 4: Type-check and tests**

Run: `bun run check && bun test apps/mesh/src/web/`
Expected: passes.

- [ ] **Step 5: Commit (only if changes were made)**

```bash
bun run fmt
git add <changed files>
git commit -m "refactor(github): require connected github for push/pull surfaces

Audited getActiveGithubRepo call-sites after agentHasConnectedGithub
landed. Switched <list> from loose to strict; <other list> kept loose
(display-only references)."
```

If no changes, skip the commit.

---

## Task 10: Delete dead code

Each deletion below has a grep-verify step. **Do NOT skip the grep** — if the search returns hits outside this plan's files, stop and reconsider.

- [ ] **Step 1: Delete `pills/thread-pills.tsx`**

Verify:
```bash
grep -rn "ThreadPills\b" apps/mesh/src/web --include="*.ts" --include="*.tsx"
```
Expected: only `apps/mesh/src/web/components/chat/pills/thread-pills.tsx` itself.

Delete:
```bash
rm apps/mesh/src/web/components/chat/pills/thread-pills.tsx
```

- [ ] **Step 2: Delete `agent-model-trigger.tsx`**

Verify:
```bash
grep -rn "AgentModelTrigger\|agent-model-trigger" apps/mesh/src/web --include="*.ts" --include="*.tsx"
```
Expected: only `apps/mesh/src/web/components/chat/agent-model-trigger.tsx` itself.

Delete:
```bash
rm apps/mesh/src/web/components/chat/agent-model-trigger.tsx
```

- [ ] **Step 3: Delete `agent-model-popover.tsx`**

Verify:
```bash
grep -rn "AgentModelPopover\|agent-model-popover" apps/mesh/src/web --include="*.ts" --include="*.tsx"
```
Expected: only `apps/mesh/src/web/components/chat/agent-model-popover.tsx` itself.

Delete:
```bash
rm apps/mesh/src/web/components/chat/agent-model-popover.tsx
```

- [ ] **Step 4: Delete `select-model/agent-models.tsx`, `agent-section.tsx`, `desktop-cli.tsx`**

Verify each in turn:
```bash
grep -rn "getAgentSections\|AgentSection\|getAgentModelSet\|DesktopCliModelSelectorBody\|AgentKind" apps/mesh/src/web --include="*.ts" --include="*.tsx"
```
Expected: only the files in `select-model/` themselves.

If a hit lands in a settings page (`getAgentModelSet` is mentioned in the SDK comment as "Kept for the settings flow that mounts `DesktopCliModelSelectorBody`"), STOP and investigate before deleting. The settings flow may still consume one of these. If it does, narrow the deletion to whichever subset is actually unused, and leave the rest with a documented call-site.

If all three are safe to remove:
```bash
rm apps/mesh/src/web/components/chat/select-model/agent-models.tsx
rm apps/mesh/src/web/components/chat/select-model/agent-section.tsx
rm apps/mesh/src/web/components/chat/select-model/desktop-cli.tsx
```

If the `select-model/` directory ends up empty after these deletions, remove it too:
```bash
rmdir apps/mesh/src/web/components/chat/select-model 2>/dev/null || true
```

- [ ] **Step 5: Run type-check + tests + lint**

```bash
bun run check
bun test
bun run lint
```

Expected: all pass. If any failures cite the deleted files, fix the unexpected call-site before continuing.

- [ ] **Step 6: Commit**

```bash
bun run fmt
git add -A apps/mesh/src/web/components/chat/
git commit -m "chore(chat): remove dead model-selector code

ThreadPills, AgentModelTrigger/Popover, getAgentSections and friends
have no remaining call-sites after ModePicker + TierTrigger landed."
```

---

## Task 11: Final verification

- [ ] **Step 1: Format, type-check, lint, and test**

```bash
bun run fmt
bun run check
bun run lint
bun test
```

Expected: all green.

- [ ] **Step 2: Manual smoke test**

Run: `bun run dev`

Verify each scenario:

| Scenario | Expected |
|---|---|
| Connected-github VM, fresh thread | Centered card has icon/title/desc/icebreakers (no branch chip). Row above input: `⎇ main ⌄  ☁ Cloud ⌄`. Tier pill in input: `Smart ⌄`. |
| Connected-github VM, after first send | Row above input: branch + mode both lock to plain labels with "Fixed for this thread" tooltip on the mode label. Tier pill still interactive. |
| Template VM (Start Website), fresh thread | Centered card has icon/title/desc/icebreakers (no branch chip). Row above input: `☁ Cloud ⌄` only. Tier pill in input. |
| Template VM, main panel tabs | Only Settings + Automations (no Preview/git tab). |
| Connected-github VM, main panel tabs | Preview + git + Settings + Automations. |
| Cloud mode → switch to Local · Claude Code (CLI connected) | Mode pill turns green-success; tier popover subtitles re-resolve from `agent-tiers.ts` (Haiku/Sonnet/Opus labels). Eager VM start fires when a branch is set. |
| Cloud mode → switch to Local · Codex (CLI NOT connected) | Codex row appears greyed with "Not connected"; still selectable; on click, mode flips but no VM start fires (because no link capability). |
| Decopilot, no admin slot, no providers configured | Tier popover rows still render with no subtitle line; selecting still works. Sending surfaces server's `TierUnavailableError` as today. |

- [ ] **Step 3: Final commit (if formatter touched anything)**

```bash
git status
# If anything is unstaged from `bun run fmt`:
git add -A
git commit -m "chore: bun run fmt"
```

---

## Self-review (post-write)

Run through the spec checklist:

| Spec section | Covered by |
|---|---|
| §"Github-connected vs template-cloned" | Tasks 1, 5, 7, 8, 9 |
| Layout (connected) | Task 5 (ChatModeRow) + Task 7 (insertion) |
| Layout (template) | Task 5 (ChatModeRow inner-gate) + Task 7 |
| ModePicker pill states (closed / popover / locked) | Task 3 |
| TierTrigger popover with mode-dependent subtitle | Tasks 2 (resolver), 4 (component) |
| `useTierSubtitle` cloud-decopilot fallback path | Task 2 implementation |
| `useTierSubtitle` local path via `resolveAgentTier` | Task 2 implementation |
| Eager VM start | Task 3 (smart wrapper) |
| Locked state for both row controls | Task 3 (locked render) + Task 5 (inherits via stream) |
| `setChatMode → pendingAgentOption` mapping | Task 2 (named `setAgentMode` to avoid collision) |
| Submit-time wiring unchanged | No task — explicitly preserved |
| Git tab gating switch | Task 8 |
| Audit of other `getActiveGithubRepo` call-sites | Task 9 |
| Deletion safety grep | Task 10 |
| Tests | Tasks 1, 2, 3, 4, 5 (per component) |

No gaps identified.
