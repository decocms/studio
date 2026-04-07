import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@deco/ui/components/tooltip.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Activity } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { UsageStats as UsageStatsType } from "@/web/lib/usage-utils.ts";
import { formatDuration } from "@/web/lib/format-time.ts";

const RING_SIZE = 16;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

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
          <span className="text-sm font-mono tabular-nums">
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
interface MessageStatsBarProps {
  usage: UsageStatsType | null | undefined;
  /** Reasoning duration in milliseconds */
  duration?: number | null;
}

export function MessageStatsBar({ usage, duration }: MessageStatsBarProps) {
  const hasDuration = duration != null && duration > 0;
  const hasCost = usage != null && (usage.cost ?? 0) > 0;
  const hasTokens = usage != null && (usage.totalTokens ?? 0) > 0;

  if (!hasDuration && !hasCost && !hasTokens) return null;

  const durationLabel = hasDuration ? formatDuration(duration! / 1000) : null;

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {durationLabel && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="tabular-nums text-sm font-mono text-muted-foreground cursor-default [@media(hover:hover)]:hover:text-foreground transition-colors select-none">
              {durationLabel}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="font-mono text-[11px]">
            <p className="opacity-60 text-[10px] mb-1">thinking</p>
            <span className="tabular-nums">
              {formatDuration(duration! / 1000)}
            </span>
            {(usage?.reasoningTokens ?? 0) > 0 && (
              <span className="ml-2 opacity-50">
                {usage!.reasoningTokens!.toLocaleString()} tok
              </span>
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {hasDuration && (hasCost || hasTokens) && (
        <span className="text-muted-foreground/40 select-none">·</span>
      )}
      {(hasCost || hasTokens) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="tabular-nums text-sm font-mono text-muted-foreground cursor-default [@media(hover:hover)]:hover:text-foreground transition-colors select-none">
              {hasCost
                ? `$${usage!.cost.toFixed(4)}`
                : `${usage!.totalTokens.toLocaleString()} tok`}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="font-mono text-[11px]">
            <p className="opacity-60 text-[10px] mb-1">tokens</p>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <span className="opacity-60">in</span>
              <span className="text-right tabular-nums">
                {(usage!.inputTokens ?? 0).toLocaleString()}
              </span>
              <span className="opacity-60">out</span>
              <span className="text-right tabular-nums">
                {(
                  (usage!.outputTokens ?? 0) - (usage?.reasoningTokens ?? 0)
                ).toLocaleString()}
              </span>
              {(usage?.reasoningTokens ?? 0) > 0 && (
                <>
                  <span className="opacity-60">think</span>
                  <span className="text-right tabular-nums">
                    {usage!.reasoningTokens!.toLocaleString()}
                  </span>
                </>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface SessionStatsProps {
  usage: UsageStatsType | null | undefined;
  totalTokens: number;
  contextWindow: number;
  onOpenContextPanel?: () => void;
}

export function SessionStats({
  usage,
  totalTokens,
  contextWindow,
  onOpenContextPanel,
}: SessionStatsProps) {
  const pct = Math.min((totalTokens / contextWindow) * 100, 100);
  const offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
  const cost = usage?.cost ?? 0;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenContextPanel}
          className={cn(
            "flex items-center gap-1.5 text-muted-foreground hover:text-foreground h-6 px-1 shrink-0",
            onOpenContextPanel ? "cursor-pointer" : "cursor-default",
          )}
        >
          <svg width={RING_SIZE} height={RING_SIZE} className="-rotate-90">
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              className="opacity-15"
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={RING_STROKE}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={offset}
              strokeLinecap="round"
              className={cn(
                pct > 90
                  ? "text-destructive"
                  : pct > 70
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            />
          </svg>
          <span className="text-[11px] font-mono tabular-nums">
            {pct.toFixed(0)}%{cost > 0 ? ` · $${cost.toFixed(2)}` : ""}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[11px]">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <span className="text-muted">context</span>
          <span className="text-right tabular-nums">{pct.toFixed(1)}%</span>
          <span className="text-muted">tokens</span>
          <span className="text-right tabular-nums">
            {totalTokens.toLocaleString()}
          </span>
          {cost > 0 && (
            <>
              <span className="text-muted">cost</span>
              <span className="text-right tabular-nums">
                ${cost.toFixed(4)}
              </span>
              <span className="text-muted">in</span>
              <span className="text-right tabular-nums">
                {inputTokens.toLocaleString()}
              </span>
              <span className="text-muted">out</span>
              <span className="text-right tabular-nums">
                {outputTokens.toLocaleString()}
              </span>
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
