import type * as React from "react";
import { Check, CheckCircle } from "@untitledui/icons";
import { cva } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

type StageState = "done" | "current" | "upcoming";

const stageVariants = cva(
  "inline-flex h-[1.625rem] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      state: {
        done: "bg-card shadow-edge text-muted-foreground",
        current: "bg-brand-lime-tint text-brand-green-dark",
        upcoming: "bg-card shadow-edge text-subtle-foreground",
      },
    },
  },
);

function StageIndicator({ state }: { state: StageState }) {
  switch (state) {
    case "done":
      return <CheckCircle aria-hidden className="size-3.5 stroke-[1.5]" />;
    case "current":
      return (
        <span aria-hidden className="flex size-3.5 items-center justify-center">
          <span className="size-2 rounded-full bg-current" />
        </span>
      );
    case "upcoming":
      return (
        <span
          aria-hidden
          className="size-3.5 rounded-full border-[1.5px] border-current"
        />
      );
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

type StageProps = React.ComponentProps<"span"> & { state: StageState };

/** One step of a flow: done (checked), current (lime) or upcoming (quiet). */
function Stage({ state, className, children, ...props }: StageProps) {
  return (
    <span
      data-slot="stage"
      data-state={state}
      aria-current={state === "current" ? "step" : undefined}
      className={cn(stageVariants({ state }), className)}
      {...props}
    >
      <StageIndicator state={state} />
      {children}
    </span>
  );
}

function stateAt(index: number, current: number): StageState {
  return index < current ? "done" : index === current ? "current" : "upcoming";
}

const numberVariants = cva(
  "tnum flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors",
  {
    variants: {
      state: {
        done: "bg-primary text-primary-foreground",
        current: "bg-brand-lime-tint text-brand-green-dark",
        upcoming: "bg-muted text-muted-foreground",
      },
    },
  },
);

type StageTrackerProps = Omit<React.ComponentProps<"ol">, "children"> & {
  /** Stage labels, in order. */
  stages: readonly string[];
  /** Index of the current stage; `stages.length` marks every stage done. */
  current: number;
  /** `pill` for a flow's status (Plan, Execute, Monitor); `numbered` for a wizard. */
  variant?: "pill" | "numbered";
  /** Makes done and visited stages clickable. */
  onStageClick?: (index: number) => void;
  /** Stages past `current` the user already reached and may jump back to. */
  visited?: ReadonlySet<number>;
};

/** Stages joined by hairline connectors. */
function StageTracker({
  stages,
  current,
  variant = "pill",
  onStageClick,
  visited,
  className,
  ...props
}: StageTrackerProps) {
  return (
    <ol
      data-slot="stage-tracker"
      data-variant={variant}
      className={cn("flex items-center gap-2", className)}
      {...props}
    >
      {stages.map((label, index) => {
        const state = stateAt(index, current);
        const clickable =
          onStageClick !== undefined &&
          index !== current &&
          (index < current || (visited?.has(index) ?? false));
        const content =
          variant === "numbered" ? (
            <span className="flex items-center gap-2">
              <span className={numberVariants({ state })}>
                {state === "done" ? (
                  <Check aria-hidden className="size-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "text-sm whitespace-nowrap",
                  state === "upcoming"
                    ? "text-muted-foreground"
                    : "text-foreground font-medium",
                )}
              >
                {label}
              </span>
            </span>
          ) : (
            <Stage state={state}>{label}</Stage>
          );
        return (
          <li key={label} className="flex items-center gap-2">
            {index > 0 && (
              <span
                aria-hidden
                className={cn(
                  "h-px",
                  variant === "numbered" ? "mx-1 w-8" : "w-6",
                  variant === "numbered" && index <= current
                    ? "bg-foreground"
                    : "bg-border",
                )}
              />
            )}
            {clickable ? (
              <button
                type="button"
                onClick={() => onStageClick(index)}
                className="focus-ring rounded-full transition-opacity hover:opacity-70"
              >
                {content}
              </button>
            ) : (
              <span
                aria-current={
                  variant === "numbered" && state === "current"
                    ? "step"
                    : undefined
                }
              >
                {content}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export { Stage, StageTracker };
export type { StageState };
