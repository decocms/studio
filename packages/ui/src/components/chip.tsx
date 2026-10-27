import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/**
 * An entity named inline — a goal, an area, an app. A white pill on a
 * hairline. Statuses are `Badge`s, not chips.
 *
 * `sm` leads with a 12px icon and reads as meta; `lg` is the app launcher
 * pill, leading with a 26px tile (a `ProjectIcon` or a logo).
 */
const chipVariants = cva(
  "bg-card shadow-edge inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-full [&_svg]:pointer-events-none [&_svg]:shrink-0 [a&]:hover:bg-accent [button&]:hover:bg-accent transition-colors focus-ring",
  {
    variants: {
      size: {
        sm: "text-muted-foreground h-6 gap-1.5 px-2 text-xs [&>svg]:size-3",
        lg: "text-foreground h-9 gap-2 px-3.5 py-1 text-sm font-medium [&>svg]:size-4 has-[>[data-slot=project-icon]]:pl-1 has-[>img]:pl-1",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

function Chip({
  className,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof chipVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="chip"
      className={cn(chipVariants({ size }), className)}
      {...props}
    />
  );
}

/** Secondary text after a chip's label: the project an app belongs to. */
function ChipMeta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="chip-meta"
      className={cn("text-subtle-foreground text-xs font-normal", className)}
      {...props}
    />
  );
}

export { Chip, ChipMeta, chipVariants };
