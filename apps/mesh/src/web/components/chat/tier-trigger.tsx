import { useState, type ReactNode } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Atom01,
  ChevronDown,
  Check,
  Cloud01,
  Lightning01,
  Monitor01,
  Stars01,
} from "@untitledui/icons";
import type { ChatTier } from "@/tools/organization/schema";
import {
  resolveTierSubtitle,
  useAgentMode,
  useChatTier,
  useSetChatTier,
  type AgentMode,
} from "./use-agent-mode";
import { useChatPrefs, useOptionalChatTask } from "./context";
import { useAgentOptionAvailability } from "./use-agent-availability";
import {
  type AgentOption,
  preferredLocalAgentOption,
} from "./pills/agent-options";
import { ClaudeCodeIcon, CodexIcon } from "./agent-icons";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];
const TIER_LABELS: Record<ChatTier, string> = {
  fast: "Fast",
  smart: "Smart",
  thinking: "Thinking",
};

/** One selectable row in the popover — a concrete (runtime, tier) choice. */
interface TierRow {
  key: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string | null;
  active: boolean;
  onSelect: () => void;
}

/**
 * A labelled cluster of rows. The `label` is the small-font runtime heading
 * (e.g. "Claude", "Codex") rendered above its tiers; omit it for a single
 * ungrouped list (Cloud, or a lone local CLI).
 */
interface TierGroup {
  key: string;
  label?: string;
  labelIcon?: ReactNode;
  rows: TierRow[];
}

interface PureProps {
  /** Active tier — drives the closed-pill label. */
  tier: ChatTier;
  /** Optional glyph rendered on the closed pill next to the tier label. */
  pillIcon?: ReactNode;
  /** Runtime × tier options, grouped by runtime. */
  groups: TierGroup[];
  /** Optional content rendered above the groups (the runtime toggle). */
  header?: ReactNode;
}

/**
 * Pure variant — no external dependencies (no context, no queries).
 * Owns only local UI state (the popover open flag) so tests can mount
 * it without mocking the chat context. Closed pill shows the icon
 * (when provided) + tier label; the popover renders `header` then one
 * block per group (optional heading + its rows). Selecting a row runs its
 * `onSelect` and closes the popover.
 */
export function TierTriggerPure({ tier, pillIcon, groups, header }: PureProps) {
  const [open, setOpen] = useState(false);
  const handleSelect = (row: TierRow) => {
    row.onSelect();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 shrink">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="default"
                aria-label={TIER_LABELS[tier]}
                className={cn(
                  "text-muted-foreground hover:text-foreground transition-[gap] duration-200 shrink min-w-0",
                  "gap-0 @[320px]/chat-bottom:gap-1.5",
                )}
              >
                {pillIcon}
                <span
                  className={cn(
                    "min-w-0 truncate transition-[max-width,opacity] duration-200 ease-out max-w-0 opacity-0",
                    "@[320px]/chat-bottom:max-w-24 @[320px]/chat-bottom:opacity-100",
                  )}
                >
                  {TIER_LABELS[tier]}
                </span>
                <ChevronDown
                  size={12}
                  className="opacity-60 hidden @[320px]/chat-bottom:inline-block"
                />
              </Button>
            </PopoverTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{TIER_LABELS[tier]}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="p-1 w-64">
        {header && (
          <div className="mb-1 border-b border-border/60 pb-1">{header}</div>
        )}
        <div role="menu" className="flex flex-col">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col">
              {group.label && (
                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
                  {group.labelIcon}
                  <span className="truncate">{group.label}</span>
                </div>
              )}
              {group.rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  role="menuitem"
                  aria-label={
                    group.label ? `${group.label} ${row.title}` : row.title
                  }
                  onClick={() => handleSelect(row)}
                  className={cn(
                    "flex items-start gap-2 px-2 py-1.5 rounded-md text-left",
                    "hover:bg-muted",
                  )}
                >
                  {row.icon && (
                    <span className="shrink-0 text-muted-foreground mt-0.5">
                      {row.icon}
                    </span>
                  )}
                  <div className="flex-1">
                    <div className="text-sm">{row.title}</div>
                    {row.subtitle && (
                      <div className="text-xs text-muted-foreground">
                        {row.subtitle}
                      </div>
                    )}
                  </div>
                  {row.active && (
                    <Check size={14} className="text-foreground mt-0.5" />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Per-tier intent glyph (Lightning / Stars / Atom). The same affordance
 * lands on every tier row regardless of the active runtime — the brand
 * glyph for the harness (Claude, Codex) rides on the group heading, not the
 * row.
 */
function tierIconFor(tier: ChatTier): ReactNode {
  if (tier === "fast") return <Lightning01 size={16} />;
  if (tier === "thinking") return <Atom01 size={16} />;
  return <Stars01 size={16} />;
}

const SEG_BTN =
  "flex items-center justify-center gap-1.5 flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors min-w-0";
const SEG_ACTIVE = "bg-background text-foreground shadow-sm";
const SEG_INACTIVE = "text-muted-foreground hover:text-foreground";

function Segmented({
  options,
}: {
  options: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    active: boolean;
    onSelect: () => void;
  }>;
}) {
  return (
    <div className="flex items-center gap-1 p-1 rounded-lg bg-muted">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={o.onSelect}
          className={cn(SEG_BTN, o.active ? SEG_ACTIVE : SEG_INACTIVE)}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Runtime location toggle shown at the top of the tier popover when a desktop
 * is linked with a coding agent: Cloud (org router) ⟷ This device. Writes the
 * (harness, sandbox) choice through `pendingAgentOption`. The specific local
 * CLI (Claude / Codex) is no longer a nested toggle here — each CLI's tiers are
 * listed directly below as their own group. Hidden on a locked thread.
 */
function RuntimeToggle() {
  const { pendingHarnessId, setPendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const isLocal =
    pendingHarnessId === "claude-code" || pendingHarnessId === "codex";
  // This toggle only renders when a local CLI is present (TierTrigger gates on
  // `hasLocal`), so the fallback is unreachable — but keep it total.
  const firstLocal: AgentOption =
    preferredLocalAgentOption(availability) ?? "claude-code-desktop";

  return (
    <div className="p-1">
      <Segmented
        options={[
          {
            key: "cloud",
            icon: <Cloud01 size={14} />,
            label: "Cloud",
            active: !isLocal,
            onSelect: () => setPendingAgentOption("decopilot"),
          },
          {
            key: "local",
            icon: <Monitor01 size={14} />,
            label: "This device",
            active: isLocal,
            onSelect: () => setPendingAgentOption(firstLocal),
          },
        ]}
      />
    </div>
  );
}

/** Build a runtime's three tier rows. Selecting a row pins the runtime (via
 *  `option`) and the tier in one click. */
function localGroup(params: {
  key: string;
  label: string | undefined;
  labelIcon: ReactNode;
  mode: AgentMode;
  option: AgentOption;
  isActiveRuntime: boolean;
  currentTier: ChatTier;
  setOption: (option: AgentOption) => void;
  setTier: (tier: ChatTier) => void;
}): TierGroup {
  return {
    key: params.key,
    label: params.label,
    labelIcon: params.labelIcon,
    rows: TIER_ORDER.map((t) => ({
      key: `${params.key}-${t}`,
      icon: tierIconFor(t),
      title: TIER_LABELS[t],
      subtitle: resolveTierSubtitle(params.mode, t),
      active: params.isActiveRuntime && params.currentTier === t,
      onSelect: () => {
        params.setOption(params.option);
        params.setTier(t);
      },
    })),
  };
}

/**
 * Smart wrapper used by `Chat.Input`. Reads current tier + mode, and builds the
 * popover groups. Cloud renders a single ungrouped list of tiers; when a
 * desktop is linked it surfaces the Cloud ⟷ This device toggle in the header
 * and — in local mode — lists each available CLI's tiers as its own group so a
 * single click picks both the runtime and the tier.
 */
export function TierTrigger() {
  const tier = useChatTier();
  const setTier = useSetChatTier();
  const mode = useAgentMode();
  const { pendingHarnessId, setPendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const taskCtx = useOptionalChatTask();
  const locked = taskCtx?.isThreadLocked ?? false;
  const hasLocal = availability.claudeCode || availability.codex;
  const isLocal = mode !== "cloud-decopilot";

  let groups: TierGroup[];
  if (isLocal) {
    // Show a CLI's group when it's detected, or when it's the active runtime
    // (so the popover never renders empty if detection lags behind a locked
    // thread's harness). Label the groups only when both are shown.
    const showClaude =
      availability.claudeCode || pendingHarnessId === "claude-code";
    const showCodex = availability.codex || pendingHarnessId === "codex";
    const bothShown = showClaude && showCodex;
    const built: TierGroup[] = [];
    if (showClaude) {
      built.push(
        localGroup({
          key: "claude-code",
          label: bothShown ? "Claude" : undefined,
          labelIcon: <ClaudeCodeIcon size={14} />,
          mode: "local-claude-code",
          option: "claude-code-desktop",
          isActiveRuntime: pendingHarnessId === "claude-code",
          currentTier: tier,
          setOption: setPendingAgentOption,
          setTier,
        }),
      );
    }
    if (showCodex) {
      built.push(
        localGroup({
          key: "codex",
          label: bothShown ? "Codex" : undefined,
          labelIcon: <CodexIcon size={14} />,
          mode: "local-codex",
          option: "codex-desktop",
          isActiveRuntime: pendingHarnessId === "codex",
          currentTier: tier,
          setOption: setPendingAgentOption,
          setTier,
        }),
      );
    }
    groups = built;
  } else {
    groups = [
      {
        key: "cloud",
        rows: TIER_ORDER.map((t) => ({
          key: `cloud-${t}`,
          icon: tierIconFor(t),
          title: TIER_LABELS[t],
          subtitle: resolveTierSubtitle("cloud-decopilot", t),
          active: tier === t,
          onSelect: () => setTier(t),
        })),
      },
    ];
  }

  return (
    <TierTriggerPure
      tier={tier}
      pillIcon={tierIconFor(tier)}
      groups={groups}
      header={hasLocal && !locked ? <RuntimeToggle /> : undefined}
    />
  );
}
