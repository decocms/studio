import { useState, type ReactNode } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Atom01,
  ChevronDown,
  Check,
  Lightning01,
  Stars01,
} from "@untitledui/icons";
import type { ChatTier } from "@/tools/organization/schema";
import { ClaudeCodeIcon, CodexIcon } from "./agent-icons";
import {
  resolveTierSubtitle,
  useAgentMode,
  useChatTier,
  useSetChatTier,
  type AgentMode,
} from "./use-agent-mode";

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
}: PureProps) {
  const [open, setOpen] = useState(false);
  const handleSelect = (t: ChatTier) => {
    onSelect(t);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={TIER_LABELS[tier]}
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          {iconFor?.(tier)}
          <span>{TIER_LABELS[tier]}</span>
          <ChevronDown size={12} className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-1 w-56">
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
 * Per-tier intent glyphs for the cloud-Decopilot popover. Same icons
 * the merged `AgentModelPopover` used pre-refactor, so users see the
 * same affordance for Fast/Smart/Thinking they're already used to.
 */
function decopilotIcon(tier: ChatTier): ReactNode {
  if (tier === "fast") return <Lightning01 size={16} />;
  if (tier === "thinking") return <Atom01 size={16} />;
  return <Stars01 size={16} />;
}

/**
 * Picks the glyph for a given (mode, tier) pair:
 *   - cloud-decopilot: per-tier intent icon (Lightning / Stars / Atom)
 *   - local-claude-code: the Claude brand glyph for every tier
 *   - local-codex: the Codex brand glyph for every tier
 * Exposed so the automations tier dropdown can reuse the cloud-Decopilot
 * icons without depending on the chat AgentMode concept.
 */
export function tierIconFor(mode: AgentMode, tier: ChatTier): ReactNode {
  if (mode === "local-claude-code") return <ClaudeCodeIcon size={16} />;
  if (mode === "local-codex") return <CodexIcon size={16} />;
  return decopilotIcon(tier);
}

/**
 * Smart wrapper used by `Chat.Input`. Reads current tier + mode, builds
 * the per-tier subtitle + icon resolvers, and writes through
 * `useSetChatTier`.
 */
export function TierTrigger() {
  const tier = useChatTier();
  const setTier = useSetChatTier();
  const mode = useAgentMode();

  const subtitleFor = (t: ChatTier): string | null =>
    resolveTierSubtitle(mode, t);
  const iconFor = (t: ChatTier): ReactNode => tierIconFor(mode, t);

  return (
    <TierTriggerPure
      tier={tier}
      subtitleFor={subtitleFor}
      iconFor={iconFor}
      onSelect={setTier}
    />
  );
}
