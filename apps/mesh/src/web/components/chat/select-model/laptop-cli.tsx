import { cn } from "@deco/ui/lib/utils.ts";
import type { ChatTier } from "@/tools/organization/schema";
import type { AgentModelSet } from "./agent-models";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";

interface LaptopCliModelSelectorProps {
  modelSet: AgentModelSet;
  selectedModelId: string | null;
  onSelect: (model: AiProviderModel) => void;
}

const TIER_ROWS: Array<{ tier: ChatTier; description: string }> = [
  { tier: "fast", description: "Quicker responses" },
  { tier: "smart", description: "Balanced quality" },
  { tier: "thinking", description: "Deeper reasoning" },
];

export function LaptopCliModelSelectorBody({
  modelSet,
  selectedModelId,
  onSelect,
}: LaptopCliModelSelectorProps) {
  const lookup = Object.fromEntries(modelSet.models.map((m) => [m.modelId, m]));

  return (
    <div className="flex flex-col p-2 w-[320px]">
      {TIER_ROWS.map(({ tier, description }) => {
        const entry = modelSet.tiers[tier];
        const model = lookup[entry.modelId];
        if (!model) return null;
        const isSelected = selectedModelId === entry.modelId;
        return (
          <button
            key={tier}
            type="button"
            onClick={() => onSelect(model)}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-accent",
              isSelected && "bg-accent/50",
            )}
          >
            <img
              src={modelSet.logo}
              alt={entry.label}
              className="size-5 shrink-0 rounded-sm dark:bg-white dark:rounded-sm dark:p-px"
            />
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-sm text-foreground leading-tight truncate">
                {entry.label}
              </span>
              <span className="text-xs text-muted-foreground leading-tight">
                {description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
