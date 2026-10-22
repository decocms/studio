import type * as React from "react";

import { cn } from "../lib/utils.ts";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "placeholder:text-subtle-foreground focus-ring aria-invalid:bg-destructive/10 aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)] flex field-sizing-content min-h-16 w-full rounded-[var(--studio-control-radius,var(--radius-xl))] bg-[var(--studio-input-background)] px-3 py-2 text-sm transition-[color,background-color,box-shadow] outline-none shadow-edge hover:bg-sidebar disabled:cursor-not-allowed disabled:text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
