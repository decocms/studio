# Merge AgentPill and AgentModelTrigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the `AgentPill` (Decopilot vs Claude Code vs Codex) into the chat-input's `AgentModelTrigger` as a sectioned popover. Local-CLI sections (Claude Code, Codex) get a green `text-success` / `bg-success/5` styling that matches the "Desktop connected" affordance, and the closed trigger turns green when a CLI model is active. Drop the legacy `decopilot-laptop` option entirely. Fix a phantom-gap bug in the trigger's collapsed state.

**Architecture:** A new pure `getAgentSections({ hasAnyKey, link })` in `select-model/agent-models.ts` becomes the single source of truth for which sections render and which are flagged `isLocal`. A new `AgentSection` component renders one section. A new `AgentModelPopover` composes sections and handles lock semantics (only the active-thread section is interactive when a thread has messages). `AgentModelTrigger` is rewritten to always use the new popover and applies success styling to the closed pill when the active agent is CLI. `ThreadPills` drops the AgentPill JSX entirely and the eager-VM-start logic moves into the popover row click.

**Tech Stack:** React 19 (no `useEffect` / no `useMemo`), Tailwind v4 with design-system tokens, container queries on `@[…]/chat-bottom`, Bun test runner, Kysely/Better Auth (unaffected). Source of truth files: `apps/mesh/src/web/components/chat/`, `apps/mesh/src/web/components/chat/pills/`, `apps/mesh/src/web/components/chat/select-model/`.

**Reference spec:** `docs/superpowers/specs/2026-05-21-merge-agent-and-model-selectors-design.md`

---

### Task 1: Trim `agent-options.ts` — drop `decopilot-laptop` and `computeAgentOptions`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/agent-options.ts`
- Delete: `apps/mesh/src/web/components/chat/pills/agent-options.test.ts`

**Why this task is first:** `decopilot-laptop` is the easiest gap to surface because it ripples through `AgentOption`, `AGENT_OPTION_PINS`, `computeAgentOptions`, and the test file. Removing it first lets every later task assume a clean three-agent universe.

- [ ] **Step 1: Confirm no callers reference `decopilot-laptop`, `computeAgentOptions`, or `AGENT_OPTION_LABELS` outside the targeted files**

Run:
```bash
rg -n "decopilot-laptop|computeAgentOptions|AGENT_OPTION_LABELS|AgentOptionsInput" apps/mesh/src
```

Expected outside the targeted files: **only** `apps/mesh/src/web/components/chat/pills/thread-pills.tsx` (uses `computeAgentOptions`) and `apps/mesh/src/web/components/chat/pills/agent-pill.tsx` (uses `AGENT_OPTION_LABELS`). Both will be removed/edited in later tasks. If anything else lights up, **STOP** and surface the new caller — the plan needs to grow a task for it.

- [ ] **Step 2: Replace `agent-options.ts` with the slim version**

Overwrite the entire file with:

```ts
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

export type AgentOption =
  | "decopilot"
  | "claude-code-laptop"
  | "codex-laptop";

export interface AgentPins {
  harness: HarnessId;
  sandbox: SandboxProviderKind | null;
}

/**
 * Canonical (harness, sandbox) pair for each `AgentOption`. The persisted
 * pending-agent value is the source of truth; everything else (chat
 * dispatch, VM start, model selector) reads through here so the pair can
 * not drift.
 */
export const AGENT_OPTION_PINS: Record<AgentOption, AgentPins> = {
  decopilot: { harness: "decopilot", sandbox: null },
  "claude-code-laptop": { harness: "claude-code", sandbox: "remote-user" },
  "codex-laptop": { harness: "codex", sandbox: "remote-user" },
};

export function pinsForOption(option: AgentOption): AgentPins {
  return AGENT_OPTION_PINS[option];
}

/** Reverse lookup — find the AgentOption matching a persisted
 *  (harness, sandbox) pair. Returns `null` when the pair is unknown. */
export function pinsToOption(
  harness: HarnessId | null,
  sandbox: SandboxProviderKind | null,
): AgentOption | null {
  if (!harness) return null;
  for (const [option, pins] of Object.entries(AGENT_OPTION_PINS) as [
    AgentOption,
    AgentPins,
  ][]) {
    if (pins.harness === harness && pins.sandbox === sandbox) return option;
  }
  return null;
}
```

- [ ] **Step 3: Delete the obsolete test file**

```bash
rm apps/mesh/src/web/components/chat/pills/agent-options.test.ts
```

The deleted tests only covered `computeAgentOptions`; `pinsForOption`/`pinsToOption` are table lookups and get exercised indirectly via the new tests added in Task 2 and Task 4.

- [ ] **Step 4: Verify type check still passes for this file**

Run:
```bash
bun run check 2>&1 | rg "agent-options.ts" || echo "no errors in agent-options.ts"
```

Expected: `no errors in agent-options.ts`. (`bun run check` runs across all workspaces and may surface errors in OTHER files that depend on the removed exports — those are addressed in Tasks 6 and 7.)

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/pills/agent-options.ts
git add apps/mesh/src/web/components/chat/pills/agent-options.test.ts
git commit -m "refactor(chat): drop decopilot-laptop AgentOption and computeAgentOptions

Removes the cloud-Decopilot-on-local-sandbox option (decopilot-laptop)
and computeAgentOptions, which gets replaced by getAgentSections in a
following commit. Keeps AGENT_OPTION_PINS + pinsForOption / pinsToOption
since chat-context.tsx still needs them. The localStorage load in
chat-context already validates against AGENT_OPTION_PINS, so stale
'decopilot-laptop' values silently migrate to null."
```

---

### Task 2: Build `getAgentSections` in `select-model/agent-models.ts`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/select-model/agent-models.ts`
- Create: `apps/mesh/src/web/components/chat/select-model/agent-models.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `apps/mesh/src/web/components/chat/select-model/agent-models.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Capability } from "@/links/protocol";
import { getAgentSections } from "./agent-models";

const OFFLINE = { online: false, capabilities: [] as readonly Capability[] };
const ONLINE = (caps: readonly Capability[]) => ({
  online: true,
  capabilities: caps,
});

describe("getAgentSections", () => {
  test("no keys + no link → empty list", () => {
    expect(
      getAgentSections({ hasAnyKey: false, link: OFFLINE }).map((s) => s.kind),
    ).toEqual([]);
  });

  test("keys + offline link → only Decopilot, not flagged local", () => {
    const sections = getAgentSections({ hasAnyKey: true, link: OFFLINE });
    expect(sections.map((s) => s.kind)).toEqual(["decopilot"]);
    expect(sections[0]!.isLocal).toBe(false);
  });

  test("no keys + online claude-code capability → only Claude Code, flagged local", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["claude-code"]),
    });
    expect(sections.map((s) => s.kind)).toEqual(["claude-code"]);
    expect(sections[0]!.isLocal).toBe(true);
  });

  test("no keys + online codex capability → only Codex, flagged local", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["codex"]),
    });
    expect(sections.map((s) => s.kind)).toEqual(["codex"]);
    expect(sections[0]!.isLocal).toBe(true);
  });

  test("keys + online both CLI caps → all three in stable order", () => {
    const sections = getAgentSections({
      hasAnyKey: true,
      link: ONLINE(["claude-code", "codex"]),
    });
    expect(sections.map((s) => s.kind)).toEqual([
      "decopilot",
      "claude-code",
      "codex",
    ]);
    expect(sections.map((s) => s.isLocal)).toEqual([false, true, true]);
  });

  test("decopilot section exposes Fast/Smart/Thinking tiers with non-null labels", () => {
    const [decopilot] = getAgentSections({ hasAnyKey: true, link: OFFLINE });
    expect(decopilot!.title).toBe("Decopilot");
    expect(decopilot!.tiers.fast.label).toBe("Fast");
    expect(decopilot!.tiers.smart.label).toBe("Smart");
    expect(decopilot!.tiers.thinking.label).toBe("Thinking");
    expect(decopilot!.tiers.fast.modelId).toBeNull();
    expect(decopilot!.tiers.smart.modelId).toBeNull();
    expect(decopilot!.tiers.thinking.modelId).toBeNull();
  });

  test("claude-code section exposes the three CLI model labels with non-null modelIds", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["claude-code"]),
    });
    const claude = sections[0]!;
    expect(claude.title).toBe("Claude Code");
    expect(claude.tiers.fast.modelId).toBe("claude-code:haiku");
    expect(claude.tiers.smart.modelId).toBe("claude-code:sonnet");
    expect(claude.tiers.thinking.modelId).toBe("claude-code:opus");
    expect(claude.tiers.fast.label).toBe("Haiku");
    expect(claude.tiers.smart.label).toBe("Sonnet");
    expect(claude.tiers.thinking.label).toBe("Opus");
  });

  test("codex section exposes the three Codex model labels", () => {
    const sections = getAgentSections({
      hasAnyKey: false,
      link: ONLINE(["codex"]),
    });
    const codex = sections[0]!;
    expect(codex.title).toBe("Codex");
    expect(codex.tiers.fast.modelId).toBe("codex:gpt-5.4-mini");
    expect(codex.tiers.smart.modelId).toBe("codex:gpt-5.3-codex");
    expect(codex.tiers.thinking.modelId).toBe("codex:gpt-5.5");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
bun test apps/mesh/src/web/components/chat/select-model/agent-models.test.ts
```

Expected: all 8 tests FAIL with `getAgentSections is not exported` (or similar — the symbol doesn't exist yet).

- [ ] **Step 3: Implement `getAgentSections` and extend `agent-models.ts`**

Open `apps/mesh/src/web/components/chat/select-model/agent-models.ts` and replace its entire contents with:

```ts
import type { ReactNode } from "react";
import type { HarnessId } from "@/harnesses";
import type { Capability } from "@/links/protocol";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import type { ChatTier } from "@/tools/organization/schema";
import { Atom01, Lightning01, Stars01 } from "@untitledui/icons";
import { CLAUDE_CODE_MODELS } from "@/ai-providers/adapters/claude-code-models";
import { CODEX_MODELS } from "@/ai-providers/adapters/codex-models";

/** The three agents that can appear as sections in the chat-input popover. */
export type AgentKind = "decopilot" | "claude-code" | "codex";

/**
 * Per-tier entry in an agent section. `modelId` is the wire identifier
 * the harness consumes (or `null` for Decopilot, where the server picks
 * the model based on tier + provider key). `iconNode` is the React icon
 * for Decopilot tiers; CLI rows use `iconUrl` instead.
 */
export interface AgentTierEntry {
  modelId: string | null;
  label: string;
  description: string;
  iconNode?: ReactNode;
  iconUrl?: string;
}

export type AgentTierMap = Record<ChatTier, AgentTierEntry>;

/** One section in the merged model selector popover. */
export interface AgentSection {
  kind: AgentKind;
  title: string;
  /** True for laptop-CLI agents (Claude Code, Codex). Drives the green
   *  band + " · on this laptop" suffix in the popover, and the green
   *  ring on the closed chat-input trigger. */
  isLocal: boolean;
  tiers: AgentTierMap;
  /** Cached list of models the agent exposes — handy for callers that
   *  need to convert a (kind, tier) into an `AiProviderModel`. */
  models: AiProviderModel[];
}

const CLAUDE_CODE_LOGO =
  "https://decoims.com/decocms/93e4059c-e598-412b-87eb-54d72a946ec8/claude-stroke-rounded.svg";
const CODEX_LOGO =
  "https://decoims.com/decocms/9170ffd4-b9cc-4661-ad8f-ae2eea019e00/codex.svg";

const DECOPILOT_TIERS: AgentTierMap = {
  fast: {
    modelId: null,
    label: "Fast",
    description: "Quicker responses",
    iconNode: <Lightning01 size={16} />,
  },
  smart: {
    modelId: null,
    label: "Smart",
    description: "Balanced quality",
    iconNode: <Stars01 size={16} />,
  },
  thinking: {
    modelId: null,
    label: "Thinking",
    description: "Deeper reasoning",
    iconNode: <Atom01 size={16} />,
  },
};

const CLAUDE_CODE_TIERS: AgentTierMap = {
  fast: {
    modelId: "claude-code:haiku",
    label: "Haiku",
    description: "Quicker responses",
    iconUrl: CLAUDE_CODE_LOGO,
  },
  smart: {
    modelId: "claude-code:sonnet",
    label: "Sonnet",
    description: "Balanced quality",
    iconUrl: CLAUDE_CODE_LOGO,
  },
  thinking: {
    modelId: "claude-code:opus",
    label: "Opus",
    description: "Deeper reasoning",
    iconUrl: CLAUDE_CODE_LOGO,
  },
};

const CODEX_TIERS: AgentTierMap = {
  fast: {
    modelId: "codex:gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Quicker responses",
    iconUrl: CODEX_LOGO,
  },
  smart: {
    modelId: "codex:gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Balanced quality",
    iconUrl: CODEX_LOGO,
  },
  thinking: {
    modelId: "codex:gpt-5.5",
    label: "GPT-5.5",
    description: "Deeper reasoning",
    iconUrl: CODEX_LOGO,
  },
};

export interface AgentModelSet {
  logo: string;
  tiers: AgentTierMap;
  models: AiProviderModel[];
}

/**
 * Returns the laptop-CLI model set for an agent, or null for Decopilot
 * (which still uses the standard provider-key path on the settings page).
 * Kept for the settings flow that mounts `LaptopCliModelSelectorBody`.
 */
export function getAgentModelSet(agent: HarnessId): AgentModelSet | null {
  if (agent === "claude-code") {
    return {
      logo: CLAUDE_CODE_LOGO,
      tiers: CLAUDE_CODE_TIERS,
      models: CLAUDE_CODE_MODELS as AiProviderModel[],
    };
  }
  if (agent === "codex") {
    return {
      logo: CODEX_LOGO,
      tiers: CODEX_TIERS,
      models: CODEX_MODELS as AiProviderModel[],
    };
  }
  return null;
}

export interface AgentSectionsInput {
  hasAnyKey: boolean;
  link: { online: boolean; capabilities: readonly Capability[] };
}

const SECTION_ORDER: AgentKind[] = ["decopilot", "claude-code", "codex"];

/**
 * Pure eligibility function for the merged chat-input popover. Returns
 * sections in stable `SECTION_ORDER`. Mirrors the gates that
 * `computeAgentOptions` used to enforce, minus `decopilot-laptop`.
 *
 * Gates:
 *   decopilot   → hasAnyKey
 *   claude-code → link.online && caps.includes("claude-code")
 *   codex       → link.online && caps.includes("codex")
 */
export function getAgentSections(input: AgentSectionsInput): AgentSection[] {
  const { hasAnyKey, link } = input;
  const has = (c: Capability) => link.capabilities.includes(c);
  const out: AgentSection[] = [];
  if (hasAnyKey) {
    out.push({
      kind: "decopilot",
      title: "Decopilot",
      isLocal: false,
      tiers: DECOPILOT_TIERS,
      models: [],
    });
  }
  if (link.online && has("claude-code")) {
    out.push({
      kind: "claude-code",
      title: "Claude Code",
      isLocal: true,
      tiers: CLAUDE_CODE_TIERS,
      models: CLAUDE_CODE_MODELS as AiProviderModel[],
    });
  }
  if (link.online && has("codex")) {
    out.push({
      kind: "codex",
      title: "Codex",
      isLocal: true,
      tiers: CODEX_TIERS,
      models: CODEX_MODELS as AiProviderModel[],
    });
  }
  return out.sort(
    (a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind),
  );
}
```

Note the file extension stays `.ts` not `.tsx`, but the `iconNode` field holds JSX. The file already won't have a `.tsx` extension by convention here — change it to `.tsx` only if `bun run check` complains. Tag the change in the commit message if you rename.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
bun test apps/mesh/src/web/components/chat/select-model/agent-models.test.ts
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Run the wider type check**

```bash
bun run check 2>&1 | rg "agent-models" || echo "agent-models clean"
```

Expected: `agent-models clean`. If `bun run check` reports JSX in `.ts`, rename to `agent-models.tsx`:
```bash
git mv apps/mesh/src/web/components/chat/select-model/agent-models.ts apps/mesh/src/web/components/chat/select-model/agent-models.tsx
```

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/select-model/agent-models.{ts,tsx,test.ts}
git commit -m "feat(chat): add getAgentSections for merged model selector

Introduces AgentKind/AgentSection types and a pure getAgentSections
function that returns the three sections (Decopilot, Claude Code,
Codex) shown in the new merged chat-input popover. Mirrors the gates
computeAgentOptions used (sans decopilot-laptop) and flags CLI
sections with isLocal: true to drive the green styling. Preserves
the existing getAgentModelSet helper used by the settings page."
```

---

### Task 3: New `AgentSection` row component

**Files:**
- Create: `apps/mesh/src/web/components/chat/select-model/agent-section.tsx`
- Create: `apps/mesh/src/web/components/chat/select-model/agent-section.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/mesh/src/web/components/chat/select-model/agent-section.test.tsx`:

```tsx
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentSection } from "./agent-section";
import { getAgentSections } from "./agent-models";

const SECTIONS = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

const decopilot = SECTIONS.find((s) => s.kind === "decopilot")!;
const claude = SECTIONS.find((s) => s.kind === "claude-code")!;

describe("AgentSection", () => {
  test("cloud section header has no success styling", () => {
    const { container } = render(
      <AgentSection
        section={decopilot}
        selectedTier="smart"
        disabled={false}
        onSelect={() => {}}
      />,
    );
    const header = container.querySelector("[data-testid=agent-section-header]");
    expect(header?.className).not.toMatch(/text-success/);
  });

  test("local CLI section header uses text-success and · on this laptop suffix", () => {
    const { container, getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled={false}
        onSelect={() => {}}
      />,
    );
    const header = container.querySelector("[data-testid=agent-section-header]");
    expect(header?.className).toMatch(/text-success/);
    expect(getByText(/Claude Code · on this laptop/)).toBeInTheDocument();
  });

  test("disabled section sets aria-disabled and stops onSelect from firing", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled
        onSelect={onSelect}
      />,
    );
    const wrapper = container.querySelector("[data-testid=agent-section]");
    expect(wrapper?.getAttribute("aria-disabled")).toBe("true");
    const rows = container.querySelectorAll("button");
    rows.forEach((b) => b.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("enabled row click fires onSelect with the row's tier", () => {
    const onSelect = mock((_tier: "fast" | "smart" | "thinking") => {});
    const { getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="smart"
        disabled={false}
        onSelect={onSelect}
      />,
    );
    getByText("Haiku").click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("fast");
  });

  test("selected row marks itself with the On indicator", () => {
    const { getByText } = render(
      <AgentSection
        section={claude}
        selectedTier="thinking"
        disabled={false}
        onSelect={() => {}}
      />,
    );
    expect(getByText("On")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test apps/mesh/src/web/components/chat/select-model/agent-section.test.tsx
```

Expected: tests FAIL with `Cannot find module './agent-section'`.

- [ ] **Step 3: Implement the component**

Create `apps/mesh/src/web/components/chat/select-model/agent-section.tsx`:

```tsx
import { Lock01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ChatTier } from "@/tools/organization/schema";
import type { AgentSection as AgentSectionData } from "./agent-models";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];

interface Props {
  section: AgentSectionData;
  selectedTier: ChatTier | null;
  disabled: boolean;
  onSelect: (tier: ChatTier) => void;
}

export function AgentSection({
  section,
  selectedTier,
  disabled,
  onSelect,
}: Props) {
  const localBand = section.isLocal && !disabled ? "bg-success/5" : "";

  return (
    <div
      data-testid="agent-section"
      aria-disabled={disabled || undefined}
      className={cn(
        "rounded-md p-1",
        localBand,
        disabled && "opacity-40 pointer-events-none",
      )}
    >
      <div
        data-testid="agent-section-header"
        className={cn(
          "flex items-center justify-between px-2 py-1 text-xs font-medium",
          section.isLocal ? "text-success" : "text-muted-foreground",
        )}
      >
        <span>
          {section.title}
          {section.isLocal && (
            <span className="text-success/80 font-normal">
              {" "}
              · on this laptop
            </span>
          )}
        </span>
        {disabled && <Lock01 size={12} className="opacity-60" />}
      </div>

      {TIER_ORDER.map((tier) => {
        const entry = section.tiers[tier];
        const isSelected = !disabled && selectedTier === tier;
        return (
          <button
            key={tier}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(tier)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
              isSelected && "bg-accent",
            )}
          >
            {entry.iconNode ? (
              <span className="size-4 inline-flex items-center justify-center text-muted-foreground">
                {entry.iconNode}
              </span>
            ) : entry.iconUrl ? (
              <img
                src={entry.iconUrl}
                alt=""
                className="size-4 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
              />
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm leading-tight">
                {entry.label}
              </span>
              <span className="text-xs text-muted-foreground leading-tight">
                {entry.description}
              </span>
            </div>
            {isSelected && (
              <span className="text-xs text-muted-foreground font-medium">
                On
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
bun test apps/mesh/src/web/components/chat/select-model/agent-section.test.tsx
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/select-model/agent-section.tsx apps/mesh/src/web/components/chat/select-model/agent-section.test.tsx
git commit -m "feat(chat): add AgentSection component for merged model selector

Renders one section in the new sectioned popover — header with the
agent title (plus ' · on this laptop' suffix for CLI agents), three
tier rows with descriptions, and the existing 'On' indicator. Local
sections sit on a faint bg-success/5 band; disabled sections render
opacity-40 + pointer-events-none + a small lock icon."
```

---

### Task 4: New `AgentModelPopover` shell

**Files:**
- Create: `apps/mesh/src/web/components/chat/agent-model-popover.tsx`
- Create: `apps/mesh/src/web/components/chat/agent-model-popover.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/mesh/src/web/components/chat/agent-model-popover.test.tsx`:

```tsx
import { describe, expect, test, mock } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentModelPopover } from "./agent-model-popover";
import { getAgentSections } from "./select-model/agent-models";

const ALL = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

describe("AgentModelPopover", () => {
  test("renders one AgentSection per item", () => {
    const { getAllByTestId } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    expect(getAllByTestId("agent-section")).toHaveLength(3);
  });

  test("when lockedAgent is set, only the matching section is enabled", () => {
    const { getAllByTestId } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent="claude-code"
        onSelect={() => {}}
      />,
    );
    const sections = getAllByTestId("agent-section");
    const disabled = sections.filter(
      (s) => s.getAttribute("aria-disabled") === "true",
    );
    expect(disabled).toHaveLength(2);
  });

  test("row click in a section calls onSelect with (kind, tier)", () => {
    const onSelect = mock(
      (_k: "decopilot" | "claude-code" | "codex", _t: "fast" | "smart" | "thinking") => {},
    );
    const { getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={onSelect}
      />,
    );
    getByText("Haiku").click();
    expect(onSelect).toHaveBeenCalledWith("claude-code", "fast");
  });

  test("locked non-active section does NOT call onSelect when its rows are clicked", () => {
    const onSelect = mock(() => {});
    const { getByText } = render(
      <AgentModelPopover
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent="claude-code"
        onSelect={onSelect}
      />,
    );
    // Fast row inside the locked Decopilot section
    getByText("Fast").click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
bun test apps/mesh/src/web/components/chat/agent-model-popover.test.tsx
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the popover**

Create `apps/mesh/src/web/components/chat/agent-model-popover.tsx`:

```tsx
import type { ChatTier } from "@/tools/organization/schema";
import { AgentSection } from "./select-model/agent-section";
import type {
  AgentKind,
  AgentSection as AgentSectionData,
} from "./select-model/agent-models";

interface Props {
  sections: AgentSectionData[];
  activeAgent: AgentKind | null;
  activeTier: ChatTier;
  /** When non-null, only the section matching this kind is interactive;
   *  the others render opacity-40 + pointer-events-none. */
  lockedAgent: AgentKind | null;
  onSelect: (agent: AgentKind, tier: ChatTier) => void;
}

export function AgentModelPopover({
  sections,
  activeAgent,
  activeTier,
  lockedAgent,
  onSelect,
}: Props) {
  return (
    <div className="flex flex-col gap-1 p-1.5 w-72">
      {sections.map((section) => {
        const disabled =
          lockedAgent !== null && lockedAgent !== section.kind;
        const selectedTier =
          activeAgent === section.kind ? activeTier : null;
        return (
          <AgentSection
            key={section.kind}
            section={section}
            selectedTier={selectedTier}
            disabled={disabled}
            onSelect={(tier) => onSelect(section.kind, tier)}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
bun test apps/mesh/src/web/components/chat/agent-model-popover.test.tsx
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/agent-model-popover.tsx apps/mesh/src/web/components/chat/agent-model-popover.test.tsx
git commit -m "feat(chat): add AgentModelPopover shell for merged selector

Composes AgentSection rows from a getAgentSections result. Handles
lock semantics — when lockedAgent is set, only the matching section
is interactive; the others render disabled. Row click fires onSelect
with (kind, tier) and the locking is verified by tests."
```

---

### Task 5: Rewrite `AgentModelTrigger` to use the new popover (+ fix gap bug + green styling)

**Files:**
- Modify: `apps/mesh/src/web/components/chat/agent-model-trigger.tsx`
- Create: `apps/mesh/src/web/components/chat/agent-model-trigger.test.tsx`

This task replaces the existing trigger entirely. The new trigger pulls its data (`hasAnyKey`, `link`) from hooks so callers don't need to thread eight props through. It receives `currentBranch` and `virtualMcpId` so it can fire the eager VM start that today lives in `ThreadPills`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mesh/src/web/components/chat/agent-model-trigger.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentModelTriggerPure } from "./agent-model-trigger";
import { getAgentSections } from "./select-model/agent-models";

const ALL = getAgentSections({
  hasAnyKey: true,
  link: { online: true, capabilities: ["claude-code", "codex"] },
});

describe("AgentModelTriggerPure", () => {
  test("closed pill is neutral when active agent is Decopilot", () => {
    const { container } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.className).not.toMatch(/text-success/);
    expect(button?.className).not.toMatch(/bg-success\/10/);
  });

  test("closed pill gets text-success and bg-success/10 when CLI agent active", () => {
    const { container } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/text-success/);
    expect(button?.className).toMatch(/bg-success\/10/);
  });

  test("closed pill uses responsive gap so collapsed label doesn't leave phantom gap", () => {
    const { container } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/\bgap-0\b/);
    expect(button?.className).toMatch(/@\[496px\]\/chat-bottom:gap-1\.5/);
  });

  test("label reflects the active CLI tier model label (Opus)", () => {
    const { getByText } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="claude-code"
        activeTier="thinking"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    expect(getByText("Opus")).toBeInTheDocument();
  });

  test("label reflects the active Decopilot tier label (Smart)", () => {
    const { getByText } = render(
      <AgentModelTriggerPure
        sections={ALL}
        activeAgent="decopilot"
        activeTier="smart"
        lockedAgent={null}
        onSelect={() => {}}
      />,
    );
    expect(getByText("Smart")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
bun test apps/mesh/src/web/components/chat/agent-model-trigger.test.tsx
```

Expected: FAIL — `AgentModelTriggerPure` doesn't exist yet.

- [ ] **Step 3: Rewrite `agent-model-trigger.tsx`**

Replace the entire contents of `apps/mesh/src/web/components/chat/agent-model-trigger.tsx` with:

```tsx
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { ChatTier } from "@/tools/organization/schema";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { track } from "@/web/lib/posthog-client";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import { useVmStart } from "@/web/components/vm/hooks/use-vm-start";
import { useChatPrefs } from "./context";
import { AgentModelPopover } from "./agent-model-popover";
import {
  type AgentKind,
  type AgentSection,
  getAgentSections,
} from "./select-model/agent-models";

interface Props {
  agent: HarnessId | null;
  sandboxKind: SandboxProviderKind | null;
  tier: ChatTier;
  /** Set when the user is on a branch — needed for the eager VM-start
   *  when the user picks a CLI agent. `null` when no branch is selected
   *  (no eager start). */
  currentBranch: string | null;
  virtualMcpId: string;
  /** Tier-only setter — kept for callers that want to swap tier without
   *  also potentially flipping agents (the popover handles agent +
   *  tier itself via `setPendingAgentOption`). */
  onSelect: (tier: ChatTier) => void;
}

/** Maps the popover's AgentKind back to the persisted AgentOption. */
function optionForAgent(kind: AgentKind) {
  switch (kind) {
    case "decopilot":
      return "decopilot" as const;
    case "claude-code":
      return "claude-code-laptop" as const;
    case "codex":
      return "codex-laptop" as const;
  }
}

function agentKindFromHarness(
  agent: HarnessId | null,
  sandboxKind: SandboxProviderKind | null,
): AgentKind | null {
  if (agent === "claude-code" && sandboxKind === "remote-user")
    return "claude-code";
  if (agent === "codex" && sandboxKind === "remote-user") return "codex";
  if (agent === "decopilot") return "decopilot";
  return null;
}

/**
 * Trigger pill in the chat input that opens the merged sectioned
 * popover (Decopilot + Claude Code + Codex). When the active agent is
 * a laptop-CLI variant the pill turns `text-success` + `bg-success/10`
 * to mirror the "Desktop connected" affordance in
 * `NoAiProviderEmptyState`. The popover handles agent + tier writes
 * atomically.
 */
export function AgentModelTrigger({
  agent,
  sandboxKind,
  tier,
  currentBranch,
  virtualMcpId,
  onSelect,
}: Props) {
  const keys = useAiProviderKeys();
  const link = useCurrentLink();
  const { setPendingAgentOption } = useChatPrefs();
  const { org } = useProjectContext();
  const mcpClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const startVm = useVmStart(mcpClient);

  const sections = getAgentSections({
    hasAnyKey: keys.length > 0,
    link,
  });

  const activeAgent = agentKindFromHarness(agent, sandboxKind);

  const handleSelect = (kind: AgentKind, nextTier: ChatTier) => {
    const opt = optionForAgent(kind);
    setPendingAgentOption(opt);
    onSelect(nextTier);
    if (kind !== "decopilot" && currentBranch) {
      startVm.mutate({
        virtualMcpId,
        branch: currentBranch,
        sandboxProviderKind: "remote-user" as const,
      });
    }
    track("agent_model_selected", { agent: kind, tier: nextTier });
  };

  return (
    <AgentModelTriggerPure
      sections={sections}
      activeAgent={activeAgent}
      activeTier={tier}
      lockedAgent={null /* lock comes from caller via ThreadPills later */}
      onSelect={handleSelect}
    />
  );
}

interface PureProps {
  sections: AgentSection[];
  activeAgent: AgentKind | null;
  activeTier: ChatTier;
  lockedAgent: AgentKind | null;
  onSelect: (kind: AgentKind, tier: ChatTier) => void;
}

/**
 * Stateless variant for tests. Renders the closed pill + popover —
 * does not touch hooks or chat prefs. Keeps `AgentModelTrigger`
 * thin so test cases don't have to mock the entire chat context.
 */
export function AgentModelTriggerPure({
  sections,
  activeAgent,
  activeTier,
  lockedAgent,
  onSelect,
}: PureProps) {
  const [open, setOpen] = useState(false);

  const section =
    sections.find((s) => s.kind === activeAgent) ?? sections[0] ?? null;
  const tierEntry = section?.tiers[activeTier];

  const isLocalActive = section?.isLocal ?? false;
  const label = tierEntry?.label ?? "";

  // Closed pill — collapses label at narrow widths; `gap-0` on the
  // outer + `@[496px]/chat-bottom:gap-1.5` keeps the icon + chevron
  // flush when the label is hidden.
  const baseClasses =
    "gap-0 @[496px]/chat-bottom:gap-1.5 text-muted-foreground hover:text-foreground";
  const localActiveClasses = isLocalActive
    ? "text-success bg-success/10 hover:text-success"
    : "";

  if (!section || !tierEntry) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          title={label}
          aria-label={label}
          className={cn(baseClasses, localActiveClasses)}
        >
          {tierEntry.iconNode ? (
            <span className="size-4 inline-flex items-center justify-center">
              {tierEntry.iconNode}
            </span>
          ) : tierEntry.iconUrl ? (
            <img
              src={tierEntry.iconUrl}
              alt=""
              className="size-4 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
            />
          ) : null}
          <span className="inline-block overflow-hidden whitespace-nowrap max-w-0 opacity-0 transition-[max-width,opacity] duration-200 ease-out @[496px]/chat-bottom:max-w-32 @[496px]/chat-bottom:opacity-100">
            {label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0">
        <AgentModelPopover
          sections={sections}
          activeAgent={activeAgent}
          activeTier={activeTier}
          lockedAgent={lockedAgent}
          onSelect={(kind, t) => {
            onSelect(kind, t);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
bun test apps/mesh/src/web/components/chat/agent-model-trigger.test.tsx
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run wider type check**

```bash
bun run check 2>&1 | rg "agent-model-trigger" || echo "trigger clean"
```

Expected: `trigger clean`.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/agent-model-trigger.tsx apps/mesh/src/web/components/chat/agent-model-trigger.test.tsx
git commit -m "feat(chat): merge agent picker into AgentModelTrigger

The trigger now opens the new sectioned AgentModelPopover (Decopilot,
Claude Code, Codex) instead of the old SimpleModeTierDropdown / CLI
tier list split. Closed pill goes text-success + bg-success/10 when
the active agent is a CLI variant, matching the 'Desktop connected'
green elsewhere. Picks both agent (via setPendingAgentOption) and
tier in a single click and fires the eager VM start for CLI agents
when a branch is set. Also fixes the phantom 6px gap that appeared
when the label collapses at narrow container widths."
```

---

### Task 6: Update the `input.tsx` call site to pass `currentBranch` and `virtualMcpId`

**Files:**
- Modify: `apps/mesh/src/web/components/chat/input.tsx` (the existing AgentModelTrigger mount around lines 597–602)

- [ ] **Step 1: Inspect the existing mount and surrounding props**

Run:
```bash
rg -n "AgentModelTrigger" apps/mesh/src/web/components/chat/input.tsx
```

Expected:
```
597:                      <AgentModelTrigger
```

- [ ] **Step 2: Determine where `currentBranch` and `virtualMcpId` live in `input.tsx`'s scope**

Run:
```bash
rg -n "currentBranch|virtualMcpId" apps/mesh/src/web/components/chat/input.tsx | head -40
```

Expected output: at least one prop or hook reference for each. If `virtualMcpId` is already in scope (it almost always is — `useChatPrefs().selectedVirtualMcp?.id` or similar), use that. If `currentBranch` isn't already a prop or in scope, plumb it from `ChatInput`'s props (it lives upstream where `ThreadPills` receives it today).

- [ ] **Step 3: Update the mount to pass the two new props**

Edit around line 597–602:

```tsx
<AgentModelTrigger
  agent={pendingHarnessId}
  sandboxKind={pendingSandboxProviderKind}
  tier={simpleModeTier}
  currentBranch={currentBranch ?? null}
  virtualMcpId={virtualMcpId}
  onSelect={setSimpleModeTier}
/>
```

If `currentBranch` is NOT in scope:
1. Find the parent that renders `<ChatInput …>` (search for `ChatInput\b` in the parent layout file).
2. Add `currentBranch: string | null` to `ChatInputProps` (or whichever interface the input uses).
3. Thread it through.
4. The same applies to `virtualMcpId` if it's not already in scope.

- [ ] **Step 4: Type check**

```bash
bun run check 2>&1 | rg "input.tsx" || echo "input.tsx clean"
```

Expected: `input.tsx clean`.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/input.tsx
git commit -m "chore(chat): pass currentBranch + virtualMcpId to AgentModelTrigger

The merged AgentModelTrigger needs both props so it can fire the eager
VM start that ThreadPills used to own when the user picks a CLI agent.
Plumbs them through the input mount without otherwise touching the
composer layout."
```

---

### Task 7: Slim `ThreadPills` — drop `AgentPill` and the VM-start coupling

**Files:**
- Modify: `apps/mesh/src/web/components/chat/pills/thread-pills.tsx`

- [ ] **Step 1: Replace the file with the slim version**

Overwrite `apps/mesh/src/web/components/chat/pills/thread-pills.tsx` with:

```tsx
import type { VmMap } from "@decocms/mesh-sdk";
import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import { BranchPill } from "./branch-pill";

interface Props {
  orgId: string;
  orgSlug: string;
  userId: string;
  virtualMcpId: string;
  connectionId: string;
  owner: string;
  repo: string;
  vmMap: VmMap | undefined;
  currentBranch: string | null;
  onBranchChange: (branch: string) => void;
  /** Kept in the signature for parity with the previous version even
   *  though the agent pill is gone — callers still pass them and they
   *  may be useful again if we revive a thread-level lock indicator. */
  threadKind: SandboxProviderKind | null;
  threadHarness: HarnessId | null;
}

export function ThreadPills({
  orgId,
  orgSlug,
  userId,
  virtualMcpId,
  connectionId,
  owner,
  repo,
  vmMap,
  currentBranch,
  onBranchChange,
}: Props) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <BranchPill
        orgId={orgId}
        orgSlug={orgSlug}
        userId={userId}
        virtualMcpId={virtualMcpId}
        connectionId={connectionId}
        owner={owner}
        repo={repo}
        vmMap={vmMap}
        value={currentBranch}
        onChange={onBranchChange}
        locked={false}
      />
    </div>
  );
}
```

**Note** the `locked={false}` on `BranchPill`: today it was `locked={isActive}` (i.e. the BranchPill locked when the thread had messages). That was a property of *the row* — not specific to the AgentPill. Preserve that behavior:

- [ ] **Step 2: Re-add the `isActive`-based BranchPill lock**

Edit the function body:

```tsx
import { useOptionalChatStream } from "../context";
// ...

export function ThreadPills({ … }: Props) {
  const stream = useOptionalChatStream();
  const isActive = (stream?.messages ?? []).length > 0;

  return (
    <div className="flex items-center gap-2 text-xs">
      <BranchPill
        orgId={orgId}
        orgSlug={orgSlug}
        userId={userId}
        virtualMcpId={virtualMcpId}
        connectionId={connectionId}
        owner={owner}
        repo={repo}
        vmMap={vmMap}
        value={currentBranch}
        onChange={onBranchChange}
        locked={isActive}
      />
    </div>
  );
}
```

- [ ] **Step 3: Type check**

```bash
bun run check 2>&1 | rg "thread-pills" || echo "thread-pills clean"
```

Expected: `thread-pills clean`.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/chat/pills/thread-pills.tsx
git commit -m "refactor(chat): drop AgentPill from ThreadPills

The agent picker now lives inside the chat-input's AgentModelTrigger.
ThreadPills shrinks back to a single BranchPill (still locked when the
thread has messages). The eager VM-start logic moves into the merged
AgentModelTrigger row click."
```

---

### Task 8: Delete the obsolete `agent-pill.tsx`

**Files:**
- Delete: `apps/mesh/src/web/components/chat/pills/agent-pill.tsx`

- [ ] **Step 1: Confirm no remaining imports**

Run:
```bash
rg -n "from\s+\".*agent-pill\"|from\s+'.*agent-pill'" apps/mesh/src
```

Expected: **empty output**. If anything matches, **STOP** — there's a caller we missed.

- [ ] **Step 2: Delete the file**

```bash
rm apps/mesh/src/web/components/chat/pills/agent-pill.tsx
```

- [ ] **Step 3: Type check**

```bash
bun run check 2>&1 | rg "agent-pill" || echo "agent-pill deletion clean"
```

Expected: `agent-pill deletion clean`.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/src/web/components/chat/pills/agent-pill.tsx
git commit -m "chore(chat): delete obsolete AgentPill component

Replaced by the sectioned popover inside AgentModelTrigger. No
remaining importers."
```

---

### Task 9: Final verification — `bun run check`, lint, fmt, and the full test suite

**Files:** none (verification only).

- [ ] **Step 1: Type check**

```bash
bun run check
```

Expected: exit code 0, no errors. If errors surface, fix them and commit per-file with a `fix(chat):` prefix.

- [ ] **Step 2: Lint**

```bash
bun run lint
```

Expected: exit code 0. Fix any errors before proceeding.

- [ ] **Step 3: Format check**

```bash
bun run fmt:check
```

Expected: clean. If anything's unformatted, run `bun run fmt` and amend the most recent commit (or add a "chore: format" commit).

- [ ] **Step 4: Run the targeted test files**

```bash
bun test \
  apps/mesh/src/web/components/chat/select-model/agent-models.test.ts \
  apps/mesh/src/web/components/chat/select-model/agent-section.test.tsx \
  apps/mesh/src/web/components/chat/agent-model-popover.test.tsx \
  apps/mesh/src/web/components/chat/agent-model-trigger.test.tsx
```

Expected: all green.

- [ ] **Step 5: Run the full chat-package test suite to make sure nothing else broke**

```bash
bun test apps/mesh/src/web/components/chat/
```

Expected: all green. (If something else has its own snapshot or behavior expectation broken, fix and commit per-file.)

- [ ] **Step 6: Smoke test in the browser**

```bash
bun run dev
```

Open the app in a browser, navigate to a chat surface, and verify:
1. The chat input no longer shows the Decopilot/Claude Code/Codex pill above it.
2. Clicking the model trigger in the input opens a sectioned popover.
3. Decopilot section has Fast/Smart/Thinking with the matching glyphs.
4. CLI sections have the green band + " · on this laptop" suffix.
5. Selecting a CLI tier turns the closed trigger green (`text-success` + `bg-success/10` ring).
6. The label collapses at narrow widths without a phantom gap.
7. Sending a message then re-opening the popover greys out the non-active sections.

- [ ] **Step 7: Final commit (if any cleanup happened)**

```bash
git status
# If clean, nothing to do. Otherwise:
git add -A
git commit -m "chore(chat): clean up after merged-selector implementation"
```

---

## Self-Review

| Spec requirement | Implemented in |
| --- | --- |
| Drop `decopilot-laptop` | Task 1 |
| New `getAgentSections` pure fn | Task 2 |
| 3 sections (Decopilot / Claude Code / Codex), 3 tiers each | Tasks 2 + 3 |
| No number shortcuts, no stars | (none added — by omission) |
| Lock semantics (non-active sections opacity-40 + pointer-events-none) | Tasks 3 + 4 |
| Green styling on local sections (`bg-success/5` + `text-success` header) | Task 3 |
| Green styling on closed trigger when CLI active (`text-success` + `bg-success/10`) | Task 5 |
| Phantom-gap fix (`gap-0 @[496px]/chat-bottom:gap-1.5`) | Task 5 |
| Hide CLI sections when laptop offline | Task 2 (via `getAgentSections`) |
| Delete AgentPill | Task 8 |
| Slim agent-options.ts (keep pins, drop computeAgentOptions etc.) | Task 1 |
| Don't delete SimpleModeTierDropdown, ModelSelectorBody, etc. | (untouched) |
| Eager VM start on CLI selection with branch | Task 5 |

Placeholder scan: none. Type consistency: `AgentKind` is the same across Tasks 2/3/4/5; `AgentSection` is the same shape end-to-end; `ChatTier` re-used.
