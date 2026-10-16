import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/**
 * Two shapes. `rounded` is the form field: white, hairline-edged, radius 10.
 * `pill` is the toolbar field — search, filters: a grey fill with no edge.
 * Both turn red with `aria-invalid` and green with `data-valid`.
 */
const inputVariants = cva(
  [
    "text-foreground placeholder:text-subtle-foreground selection:bg-primary selection:text-primary-foreground flex w-full min-w-0 text-sm transition-[color,background-color,box-shadow] outline-none",
    "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
    "disabled:pointer-events-none disabled:text-subtle-foreground disabled:placeholder:text-subtle-foreground",
    "read-only:text-muted-foreground",
    "focus-ring",
    "aria-invalid:bg-destructive/10 aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]",
    "data-valid:bg-success/10 data-valid:shadow-[inset_0_0_0_1px_var(--success)]",
  ],
  {
    variants: {
      shape: {
        rounded:
          "rounded-[var(--studio-control-radius,var(--radius-lg))] bg-[var(--studio-input-background)] card-shadow hover:bg-sidebar read-only:bg-sidebar",
        pill: "bg-muted rounded-full hover:bg-secondary-hover read-only:bg-sidebar",
      },
      size: {
        default: "h-[var(--studio-control-height,2.25rem)] px-3 py-1",
        sm: "h-8 px-3 py-1",
      },
    },
    compoundVariants: [{ shape: "pill", size: "default", className: "px-4" }],
    defaultVariants: { shape: "rounded", size: "default" },
  },
);

function Input({
  className,
  type,
  shape,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ shape, size }), className)}
      {...props}
    />
  );
}

export { Input, inputVariants };
