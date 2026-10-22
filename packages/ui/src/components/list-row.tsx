import type * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const listRowVariants = cva("flex w-full min-w-0 items-center gap-3", {
  variants: {
    variant: {
      /** A row in a card: a 32px tile, a regular title. */
      default: "py-2",
      /** A row in a list: hairline under it, a round lead, a medium title. */
      divided: "border-b py-2.5 last:border-b-0",
    },
    /** Opens something: hover tint and the focus ring. Pair with `asChild`. */
    interactive: {
      true: "hover:bg-accent aria-[current=true]:bg-accent aria-[current=page]:bg-accent focus-ring cursor-pointer px-2 text-left transition-colors",
      false: "",
    },
  },
  compoundVariants: [
    { variant: "default", interactive: true, class: "rounded-[0.625rem]" },
  ],
  defaultVariants: { variant: "default", interactive: false },
});

const leadVariants = cva(
  "bg-muted flex shrink-0 items-center justify-center overflow-hidden [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "size-8 rounded-[0.625rem] [&_svg]:size-4",
        divided: "size-7 rounded-full [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type ListRowProps = Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof listRowVariants> & {
    /** An icon, an avatar or a project tile. */
    lead?: React.ReactNode;
    title: React.ReactNode;
    meta?: React.ReactNode;
    /** An action or a value at the end of the row. */
    trailing?: React.ReactNode;
    /** The current item of a list, e.g. the open section. */
    selected?: boolean;
    /** Render as the given link or button; the row fills it. */
    asChild?: boolean;
  };

/** One thing in a list: lead, title over meta, and an optional trailing action. */
function ListRow({
  lead,
  title,
  meta,
  trailing,
  variant,
  interactive,
  selected,
  asChild = false,
  className,
  children,
  ...props
}: ListRowProps) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="list-row"
      aria-current={selected || undefined}
      className={cn(
        listRowVariants({ variant, interactive: interactive ?? asChild }),
        className,
      )}
      {...props}
    >
      {lead && <span className={leadVariants({ variant })}>{lead}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-sm",
            variant === "divided" && "font-medium",
          )}
        >
          {title}
        </span>
        {meta && (
          <span
            className={cn(
              "truncate text-xs",
              variant === "divided"
                ? "text-muted-foreground"
                : "text-subtle-foreground",
            )}
          >
            {meta}
          </span>
        )}
      </div>
      {trailing}
      {asChild && <Slottable>{children}</Slottable>}
    </Comp>
  );
}

export { ListRow, listRowVariants };
