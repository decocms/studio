import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ToolSelectionStrategy } from "@/mcp-clients/virtual-mcp/types";
import { ArrowsRight, Check, Code01, Lightbulb02 } from "@untitledui/icons";
import { useState } from "react";

/**
 * Mode configuration with business-friendly labels and descriptions
 */
const MODE_CONFIGS: Record<
  ToolSelectionStrategy,
  {
    label: string;
    description: string;
    icon: typeof ArrowsRight;
    recommended?: boolean;
  }
> = {
  passthrough: {
    label: "Direct access",
    description: "Best for small teams or when you need predictable behavior",
    icon: ArrowsRight,
  },
  smart_tool_selection: {
    label: "Smart discovery",
    description:
      "Ideal for large teams with many tools - AI finds what it needs",
    icon: Lightbulb02,
  },
  code_execution: {
    label: "Smart execution",
    description: "Maximum flexibility - AI can write code to orchestrate tools",
    icon: Code01,
    recommended: true,
  },
};

function ModeItemContent({
  mode,
  isSelected,
  onSelect,
}: {
  mode: ToolSelectionStrategy;
  isSelected?: boolean;
  onSelect: () => void;
}) {
  const config = MODE_CONFIGS[mode];
  const Icon = config.icon;

  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 py-3 px-3 hover:bg-accent/50 cursor-pointer rounded-lg transition-colors",
        isSelected && "bg-accent/50",
      )}
    >
      {/* Icon */}
      <div className="p-1.5 shrink-0 rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>

      {/* Text Content */}
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {config.label}
          </span>
          {config.recommended && (
            <Badge variant="outline" className="text-xs">
              Recommended
            </Badge>
          )}
          {isSelected && (
            <Check size={16} className="text-foreground shrink-0 ml-auto" />
          )}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {config.description}
        </p>
      </div>
    </div>
  );
}

export interface ModeSelectorProps {
  selectedMode: ToolSelectionStrategy;
  onModeChange: (mode: ToolSelectionStrategy) => void;
  variant?: "borderless" | "bordered";
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Mode selector component for choosing agent execution mode.
 * Displays business-friendly labels consistent with the share modal.
 */
export function ModeSelector({
  selectedMode,
  onModeChange,
  className,
  disabled = false,
}: ModeSelectorProps) {
  const [open, setOpen] = useState(false);

  const handleModeChange = (mode: ToolSelectionStrategy) => {
    onModeChange(mode);
    setOpen(false);
  };

  return (
    <Popover open={disabled ? false : open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  "flex items-center justify-center size-8 rounded-md border border-border text-muted-foreground/75 transition-colors shrink-0",
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:text-muted-foreground",
                  className,
                )}
              >
                {(() => {
                  const Icon = MODE_CONFIGS[selectedMode]?.icon ?? ArrowsRight;
                  return <Icon size={16} />;
                })()}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {MODE_CONFIGS[selectedMode]?.label ?? "Choose agent mode"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        className="w-[350px] p-0 overflow-hidden"
        align="start"
        side="top"
        sideOffset={8}
      >
        <div className="flex flex-col p-1">
          {(Object.keys(MODE_CONFIGS) as ToolSelectionStrategy[]).map(
            (mode) => (
              <ModeItemContent
                key={mode}
                mode={mode}
                isSelected={mode === selectedMode}
                onSelect={() => handleModeChange(mode)}
              />
            ),
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
