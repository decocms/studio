import type * as React from "react";

import { cn } from "../lib/utils.ts";

type SparklineProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** One bar per value, oldest first. Scaled so the largest fills the height. */
  values: readonly number[];
};

/** A trend in a glance: thin purple bars, bottom-aligned, 20px tall. */
function Sparkline({ values, className, ...props }: SparklineProps) {
  const max = Math.max(...values, 0);
  return (
    <span
      data-slot="sparkline"
      aria-hidden
      className={cn("inline-flex h-5 shrink-0 items-end gap-0.5", className)}
      {...props}
    >
      {values.map((value, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a series is positional and values repeat
          key={index}
          className="bg-brand-purple w-0.5 rounded-[1px]"
          style={{
            height: `${max > 0 ? Math.max(8, (value / max) * 100) : 8}%`,
          }}
        />
      ))}
    </span>
  );
}

export { Sparkline };
