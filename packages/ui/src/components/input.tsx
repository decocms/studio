import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/** Red with `aria-invalid`, green with `data-valid`. */
const inputVariants = cva(
  [
    "text-foreground placeholder:text-subtle-foreground selection:bg-primary selection:text-primary-foreground flex w-full min-w-0 text-sm transition-[color,background-color,box-shadow] outline-none",
    "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
    "disabled:pointer-events-none disabled:text-subtle-foreground disabled:placeholder:text-subtle-foreground",
    "read-only:text-muted-foreground",
    "focus-ring",
    "aria-invalid:bg-destructive/10 aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]",
    "data-valid:bg-success/10 data-valid:shadow-[inset_0_0_0_1px_var(--success)]",
    "rounded-[var(--studio-control-radius,var(--radius-lg))] bg-[var(--studio-input-background)] shadow-edge hover:bg-sidebar read-only:bg-sidebar",
  ],
  {
    variants: {
      size: {
        default: "h-[var(--studio-control-height,2.25rem)] px-3 py-1",
        sm: "h-8 px-3 py-1",
      },
    },
    defaultVariants: { size: "default" },
  },
);

function Input({
  className,
  type,
  size,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  );
}

/** An input with icons, text or buttons inside it; the group draws the field. */
function InputGroup({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="input-group"
      data-size={size}
      className={cn(
        "flex h-[var(--studio-control-height,2.25rem)] data-[size=sm]:h-8 w-full min-w-0 items-center gap-0.5 rounded-[var(--studio-control-radius,var(--radius-lg))] bg-[var(--studio-input-background)] px-1 text-sm shadow-edge transition-[background-color,box-shadow] hover:bg-sidebar focus-within-ring has-[[aria-invalid=true]]:bg-destructive/10 has-[[aria-invalid=true]]:shadow-[inset_0_0_0_1px_var(--destructive)] has-[input:disabled]:pointer-events-none",
        "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.33] [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input-group-input"
      className={cn(
        "text-foreground placeholder:text-subtle-foreground disabled:text-subtle-foreground h-full min-w-0 flex-1 bg-transparent px-2 text-sm outline-none",
        className,
      )}
      {...props}
    />
  );
}

/** Text or an icon at either end: a currency, a protocol, a search glass. */
function InputGroupAddon({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="input-group-addon"
      className={cn(
        "text-muted-foreground flex shrink-0 items-center px-2",
        className,
      )}
      {...props}
    />
  );
}

export { Input, InputGroup, InputGroupAddon, InputGroupInput, inputVariants };
