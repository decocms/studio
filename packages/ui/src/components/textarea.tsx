import type * as React from "react";

import { cn } from "../lib/utils.ts";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "text-foreground placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full rounded-(--studio-control-radius) bg-[var(--studio-input-background)] px-(--space-s) py-(--space-xs) text-s font-regular shadow-(--edge) transition-[background-color,box-shadow,color] duration-(--motion-duration) ease-motion",
        "hover:shadow-[0_0_0_var(--border-s)_var(--neutral-5)] focus-ring",
        "[&[readonly]:not(:disabled)]:bg-neutral-2 [&[readonly]:not(:disabled)]:text-neutral-8",
        "disabled:cursor-not-allowed disabled:bg-neutral-3 disabled:text-neutral-6 disabled:shadow-[0_0_0_var(--border-s)_var(--neutral-4-transparent)]",
        "aria-invalid:shadow-[0_0_0_var(--border-s)_var(--error)]",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
