import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const cardVariants = cva("surface flex flex-col gap-4", {
  variants: {
    size: {
      /** A section on a page: settings, a tab's panel. */
      default: "p-5",
      /** One thing in a grid: a project, a connection, an app. */
      tile: "gap-3 p-4",
      /** Edge-to-edge rows or media; the children bring their own padding. */
      flush: "p-0",
    },
    /** Opens something: tints on hover and takes the focus ring. */
    interactive: {
      true: "surface-interactive focus-ring cursor-pointer text-left",
      false: "",
    },
  },
  defaultVariants: { size: "default", interactive: false },
});

/** A titled group or one thing you open. Statuses are `Alert`s, numbers are `MetricCard`s. */
function Card({
  className,
  size,
  interactive,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof cardVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="card"
      className={cn(cardVariants({ size, interactive }), className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min items-start gap-1 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-meta", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("text-sm", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

/** A grey well inside a card: a nested list, code, a preview. Never a card in a card. */
function CardInset({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-inset"
      className={cn("surface-inset p-3", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardInset,
  CardTitle,
  cardVariants,
};
