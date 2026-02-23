import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@deco/ui/components/tooltip.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Activity, Coins01 } from "@untitledui/icons";
import type { UsageStats as UsageStatsType } from "@/web/lib/usage-utils.ts";

interface UsageStatsProps {
  usage: UsageStatsType | null | undefined;
}

export function MessageUsageStats({ usage }: UsageStatsProps) {
  if (!usage) return null;
  const { totalTokens, inputTokens, outputTokens, cost } = usage;
  if (!totalTokens && !inputTokens && !outputTokens) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground pl-1! h-6 gap-1 whitespace-nowrap shrink-0"
        >
          <Activity size={12} />
          <span className="text-[10px] font-mono tabular-nums">
            {totalTokens.toLocaleString()}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[11px]">
        <p className="text-muted text-[10px] mb-1">tokens</p>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <span className="text-muted">in</span>
          <span className="text-right tabular-nums">
            {inputTokens.toLocaleString()}
          </span>
          <span className="text-muted">out</span>
          <span className="text-right tabular-nums">
            {(outputTokens - (usage.reasoningTokens ?? 0)).toLocaleString()}
          </span>
          {cost > 0 && (
            <>
              <span className="text-muted">cost</span>
              <span className="text-right tabular-nums">
                ${cost.toFixed(4)}
              </span>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
export function ThreadUsageStats({ usage }: UsageStatsProps) {
  if (!usage) return null;
  const { totalTokens, inputTokens, outputTokens, cost } = usage;
  if (!totalTokens && !inputTokens && !outputTokens) return null;
  if (cost <= 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground pl-1! h-6 gap-1 whitespace-nowrap shrink-0"
        >
          <Coins01 size={12} />
          <span className="text-[10px] font-mono tabular-nums">
            ${cost.toFixed(4)}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[11px]">
        <p className="text-muted text-[10px] mb-1">tokens</p>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <span className="text-muted">in</span>
          <span className="text-right tabular-nums">
            {inputTokens.toLocaleString()}
          </span>
          <span className="text-muted">out</span>
          <span className="text-right tabular-nums">
            {outputTokens.toLocaleString()}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
