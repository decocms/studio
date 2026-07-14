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

interface PureProps {
  tier: ChatTier;
  subtitleFor: (tier: ChatTier) => string | null;
  /** Optional per-tier glyph rendered on the closed pill and on each
   *  popover row. Omit for a label-only treatment. */
  iconFor?: (tier: ChatTier) => ReactNode;
  onSelect: (tier: ChatTier) => void;
  /** Optional content rendered above the tier rows (the runtime toggle). */
  header?: ReactNode;
}

/**
 * Pure variant — no external dependencies (no context, no queries).
 * Owns only local UI state (the popover open flag) so tests can mount
 * it without mocking the chat context. Closed pill shows the icon
 * (when provided) + tier label; popover shows three rows with the
 * subtitle resolved via the injected `subtitleFor`.
 */
export function TierTriggerPure({
  tier,
  subtitleFor,
  iconFor,
  onSelect,
  header,
}: PureProps) {
  const [open, setOpen] = useState(false);
  const handleSelect = (t: ChatTier) => {
    onSelect(t);
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
                {iconFor?.(tier)}
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
          {TIER_ORDER.map((t) => {
            const subtitle = subtitleFor(t);
            const icon = iconFor?.(t);
            const active = t === tier;
            return (
              <button
                key={t}
                type="button"
                role="menuitem"
                aria-label={TIER_LABELS[t]}
                onClick={() => handleSelect(t)}
                className={cn(
                  "flex items-start gap-2 px-2 py-1.5 rounded-md text-left",
                  "hover:bg-muted",
                )}
              >
                {icon && (
                  <span className="shrink-0 text-muted-foreground mt-0.5">
                    {icon}
                  </span>
                )}
                <div className="flex-1">
                  <div className="text-sm">{TIER_LABELS[t]}</div>
                  {subtitle && (
                    <div className="text-xs text-muted-foreground">
                      {subtitle}
                    </div>
                  )}
                </div>
                {active && (
                  <Check size={14} className="text-foreground mt-0.5" />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Per-tier intent glyph (Lightning / Stars / Atom). The same affordance
 * lands on every tier popover regardless of the active mode — the brand
 * glyph for the harness (Claude, Codex, Cloud) belongs on the ModePicker
 * pill, not here. Exported so the automations tier dropdown can reuse
 * it without depending on the chat AgentMode concept.
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
 * Runtime chooser shown at the top of the tier popover when a desktop is
 * linked with a coding agent: Cloud (org router) ⟷ This device, and — when
 * both local CLIs are present — Claude ⟷ Codex. Writes the (harness, sandbox)
 * choice through `pendingAgentOption`; the tier rows below then map to that
 * runtime's models. Hidden on a locked thread (the runtime can't change).
 */
function RuntimeSection() {
  const { pendingHarnessId, setPendingAgentOption } = useChatPrefs();
  const availability = useAgentOptionAvailability();
  const isLocal =
    pendingHarnessId === "claude-code" || pendingHarnessId === "codex";
  const bothClis = availability.claudeCode && availability.codex;
  // This section only renders when a local CLI is present (TierTrigger gates on
  // `hasLocal`), so the fallback is unreachable — but keep it total.
  const firstLocal: AgentOption =
    preferredLocalAgentOption(availability) ?? "claude-code-desktop";

  return (
    <div className="flex flex-col gap-1.5 p-1">
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
      {isLocal && bothClis && (
        <Segmented
          options={[
            {
              key: "claude",
              icon: <ClaudeCodeIcon size={14} />,
              label: "Claude",
              active: pendingHarnessId === "claude-code",
              onSelect: () => setPendingAgentOption("claude-code-desktop"),
            },
            {
              key: "codex",
              icon: <CodexIcon size={14} />,
              label: "Codex",
              active: pendingHarnessId === "codex",
              onSelect: () => setPendingAgentOption("codex-desktop"),
            },
          ]}
        />
      )}
    </div>
  );
}

/**
 * Smart wrapper used by `Chat.Input`. Reads current tier + mode, builds
 * the per-tier subtitle resolver, and writes through `useSetChatTier`. When a
 * desktop is linked (and the thread isn't locked) it also surfaces the runtime
 * chooser above the tiers — this is where "use local models" lives in chat.
 */
export function TierTrigger() {
  const tier = useChatTier();
  const setTier = useSetChatTier();
  const mode = useAgentMode();
  const availability = useAgentOptionAvailability();
  const taskCtx = useOptionalChatTask();
  const locked = taskCtx?.isThreadLocked ?? false;
  const hasLocal = availability.claudeCode || availability.codex;

  const subtitleFor = (t: ChatTier): string | null =>
    resolveTierSubtitle(mode, t);

  return (
    <TierTriggerPure
      tier={tier}
      subtitleFor={subtitleFor}
      iconFor={tierIconFor}
      onSelect={setTier}
      header={hasLocal && !locked ? <RuntimeSection /> : undefined}
    />
  );
}
