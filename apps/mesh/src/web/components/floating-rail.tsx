import type { ComponentProps, ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

export type FloatingRailSemantic =
  | "default"
  | "primary"
  | "warning"
  | "success"
  | "destructive"
  | "neutral";

const SEMANTIC_CLASS: Record<FloatingRailSemantic, string> = {
  default:
    "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
  primary: "bg-primary/10 text-primary hover:bg-primary/15",
  warning: "bg-warning/15 text-warning-foreground hover:bg-warning/25",
  success: "bg-success/10 text-success hover:bg-success/20",
  destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
  neutral: "bg-muted text-muted-foreground hover:bg-accent",
};

export function FloatingRail({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex flex-col items-center gap-0.5 rounded-full border bg-background/90 p-1 shadow-lg backdrop-blur-sm">
        {children}
      </div>
    </TooltipProvider>
  );
}

export function FloatingRailDivider() {
  return <div className="my-0.5 h-px w-5 shrink-0 bg-border" />;
}

export function FloatingRailIconButton({
  label,
  tooltip = label,
  active = false,
  locked = false,
  semantic = "default",
  className,
  children,
  onClick,
  ...props
}: ComponentProps<"button"> & {
  label: string;
  tooltip?: string;
  active?: boolean;
  locked?: boolean;
  semantic?: FloatingRailSemantic;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-8 shrink-0">
          <button
            type="button"
            aria-label={label}
            aria-pressed={active || undefined}
            aria-disabled={locked || undefined}
            className={cn(
              "relative flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-55",
              locked && "pointer-events-none",
              active
                ? "bg-sidebar-accent text-sidebar-foreground"
                : SEMANTIC_CLASS[semantic],
              className,
            )}
            {...props}
            onClick={locked ? undefined : onClick}
          >
            {children}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
