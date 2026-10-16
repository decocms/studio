import type * as React from "react";
import { CheckCircle } from "@untitledui/icons";
import { cva } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

type StageState = "done" | "current" | "upcoming";

const stageVariants = cva(
  "inline-flex h-[1.625rem] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      state: {
        done: "hairline text-muted-foreground",
        current: "bg-brand-lime-tint text-brand-green-dark",
        upcoming: "hairline text-subtle-foreground",
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

type StageTrackerProps = Omit<React.ComponentProps<"ol">, "children"> & {
  /** Stage labels, in order. */
  stages: readonly string[];
  /** Index of the current stage; `stages.length` marks every stage done. */
  current: number;
};

/** Stages joined by hairline connectors — e.g. Plan → Execute → Monitor. */
function StageTracker({
  stages,
  current,
  className,
  ...props
}: StageTrackerProps) {
  return (
    <ol
      data-slot="stage-tracker"
      className={cn("flex items-center gap-2", className)}
      {...props}
    >
      {stages.map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden className="bg-border h-px w-6" />}
          <Stage
            state={
              index < current
                ? "done"
                : index === current
                  ? "current"
                  : "upcoming"
            }
          >
            {label}
          </Stage>
        </li>
      ))}
    </ol>
  );
}

export { Stage, StageTracker };
export type { StageState };
