import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@deco/ui/lib/utils.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/20 focus-visible:ring-[2px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "text-foreground bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50 card-shadow",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        success:
          "bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success/20 dark:focus-visible:ring-success/40",
        special:
          "bg-special text-special-foreground hover:bg-special/90 focus-visible:ring-special/20 dark:focus-visible:ring-special/40",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-foreground/80 hover:text-foreground",
      },
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        sm: "h-7 gap-1.5 px-2.5 has-[>svg]:px-2",
        xs: "h-6 gap-1 px-1.5 text-xs has-[>svg]:px-1",
        lg: "h-10 px-3.5 has-[>svg]:px-3",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
