import { Lock01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ChatTier } from "@/tools/organization/schema";
import type { AgentSection as AgentSectionData } from "./agent-models";

const TIER_ORDER: ChatTier[] = ["fast", "smart", "thinking"];

interface Props {
  section: AgentSectionData;
  selectedTier: ChatTier | null;
  disabled: boolean;
  hideHeader?: boolean;
  onSelect: (tier: ChatTier) => void;
}

export function AgentSection({
  section,
  selectedTier,
  disabled,
  hideHeader,
  onSelect,
}: Props) {
  const localBand =
    !hideHeader && section.isLocal && !disabled ? "bg-success/5" : "";

  return (
    <div
      data-testid="agent-section"
      aria-disabled={disabled || undefined}
      className={cn(
        "p-1 flex flex-col gap-0.5",
        section.isLocal ? "rounded-none" : "rounded-md",
        localBand,
        disabled && "opacity-40 pointer-events-none",
      )}
    >
      {!hideHeader && (
        <div
          data-testid="agent-section-header"
          className={cn(
            "flex items-center justify-between px-2 py-1 text-xs font-medium",
            section.isLocal ? "text-success" : "text-muted-foreground",
          )}
        >
          <span>
            {section.isLocal ? `${section.title} · on desktop` : section.title}
          </span>
          {disabled && <Lock01 size={12} className="opacity-60" />}
        </div>
      )}

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
              "flex w-full items-center gap-2.5 rounded-md px-2 py-3.5 text-left text-sm hover:bg-accent",
              isSelected && "bg-accent",
            )}
          >
            {entry.iconNode ? (
              <span className="size-4 inline-flex items-center justify-center text-muted-foreground shrink-0">
                {entry.iconNode}
              </span>
            ) : entry.iconUrl ? (
              <img
                src={entry.iconUrl}
                alt=""
                className="size-4 shrink-0 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
              />
            ) : null}
            <span className="text-sm leading-tight truncate shrink-0">
              {entry.label}
            </span>
            <span className="text-xs text-muted-foreground leading-tight truncate flex-1 text-right">
              {entry.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
