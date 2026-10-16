import type * as React from "react";
import { ArrowUp } from "@untitledui/icons";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

/**
 * Where you talk to the agent: a white card on a hairline with a soft drop.
 * `full` stacks the text over a row of tools; `compact` keeps everything on
 * one line, for side panels and threads.
 */
const composerVariants = cva(
  "bg-card text-card-foreground flex w-full rounded-2xl shadow-[inset_0_0_0_1px_var(--hairline),0_4px_16px_0_#0000000d] focus-within:shadow-[inset_0_0_0_1px_var(--input),0_4px_16px_0_#0000000d] transition-shadow",
  {
    variants: {
      size: {
        full: "flex-col gap-3 pt-3 pr-2.5 pb-2.5 pl-4",
        compact: "items-center gap-2.5 py-2.5 pr-2.5 pl-4",
      },
    },
    defaultVariants: { size: "full" },
  },
);

function Composer({
  className,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof composerVariants>) {
  return (
    <div
      data-slot="composer"
      data-size={size ?? "full"}
      className={cn(composerVariants({ size }), className)}
      {...props}
    />
  );
}

function ComposerInput({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="composer-input"
      rows={1}
      className={cn(
        "placeholder:text-subtle-foreground field-sizing-content max-h-60 min-w-0 flex-1 resize-none bg-transparent text-sm outline-none",
        className,
      )}
      {...props}
    />
  );
}

/** The row of tools: context, attach, voice, send. Icons are muted and thin. */
function ComposerToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-toolbar"
      className={cn(
        "flex items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:stroke-[1.33]",
        className,
      )}
      {...props}
    />
  );
}

function ComposerSend({
  className,
  label,
  ...props
}: Omit<
  React.ComponentProps<typeof Button>,
  "children" | "size" | "variant"
> & {
  /** Accessible name, translated by the caller. */
  label: string;
}) {
  return (
    <Button
      data-slot="composer-send"
      size="icon-sm"
      aria-label={label}
      className={className}
      {...props}
    >
      <ArrowUp className="text-primary-foreground" />
    </Button>
  );
}

export { Composer, ComposerInput, ComposerSend, ComposerToolbar };
