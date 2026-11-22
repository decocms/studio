import type * as React from "react";

import { cn } from "../lib/utils.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-(--studio-control-height) w-full min-w-0 rounded-(--studio-control-radius) bg-[var(--studio-input-background)] px-(--space-s) py-(--space-xs) text-s font-regular shadow-(--edge) transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion file:inline-flex file:h-full file:border-0 file:bg-transparent file:text-s file:font-medium",
        "hover:shadow-[0_0_0_var(--border-s)_var(--neutral-5)] focus-ring",
        /* `[readonly]` rather than `read-only:`, which also matches disabled inputs. */
        "[&[readonly]:not(:disabled)]:bg-neutral-2 [&[readonly]:not(:disabled)]:text-neutral-8",
        "disabled:pointer-events-none disabled:bg-neutral-3 disabled:text-neutral-6 disabled:shadow-[0_0_0_var(--border-s)_var(--neutral-4-transparent)]",
        "aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
