"use client";

import type * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog.tsx";
import { SearchMd } from "@untitledui/icons";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  filter,
  shouldFilter,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  /** Overrides cmdk's default fuzzy scorer (e.g. a stricter substring match). */
  filter?: React.ComponentProps<typeof CommandPrimitive>["filter"];
  /** `false` when EVERY row is already the answer — a dialog that renders a
   *  server-side search and nothing else, whose rows cmdk cannot score because
   *  the text that matched (a task key, a message body) is not in the item's
   *  `value`.
   *
   *  Not for a dialog that MIXES server rows with local ones (destinations,
   *  actions, a project list). This switch is list-wide, so turning it off to
   *  save the server rows also stops the local ones from filtering, and every
   *  one of them stays on screen no matter what is typed. Leave it on there
   *  and give each server row `keywords={[searchTerm]}` instead — see
   *  `command-filter.test.ts` and `command-palette.tsx`. */
  shouldFilter?: React.ComponentProps<typeof CommandPrimitive>["shouldFilter"];
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn("overflow-hidden p-0", className)}
        closeButtonClassName="hidden"
      >
        <Command
          filter={filter}
          shouldFilter={shouldFilter}
          className="[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg:not([class*='size-'])]:h-5 [&_[cmdk-item]_svg:not([class*='size-'])]:w-5"
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** `sm` is for the input of a Command used as a MENU rather than as a palette:
 *  a shorter field, so a field picker does not read like ⌘K. */
type CommandSize = "default" | "sm";

function CommandInput({
  className,
  size = "default",
  variant = "underline",
  action,
  ...props
}: Omit<React.ComponentProps<typeof CommandPrimitive.Input>, "size"> & {
  /** Shadows the HTML `size` attribute, which a search input has no use for. */
  size?: CommandSize;
  /**
   * `underline` — the palette's search row, divided from its results by a rule.
   * `boxed` — a standalone field that reads as an input, for a picker whose
   * list is a separate block below it rather than the same surface.
   */
  variant?: "underline" | "boxed";
  /** Trailing control on the search row, e.g. a way out to a fuller picker. */
  action?: React.ReactNode;
}) {
  const height = size === "sm" ? "h-9" : "h-10";
  const boxed = variant === "boxed";
  return (
    <div
      data-slot="command-input-wrapper"
      data-variant={variant}
      className={cn(
        "flex items-center gap-2 px-3",
        height,
        boxed
          ? "rounded-xl border border-input bg-transparent focus-within:border-ring"
          : "border-b",
      )}
    >
      {/* The boxed field carries its own frame, so the magnifier would be a
          second thing saying "type here". */}
      {!boxed && <SearchMd className="size-4 shrink-0 text-muted-foreground" />}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "placeholder:text-muted-foreground flex w-full rounded-md bg-transparent text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          height,
          className,
        )}
        {...props}
      />
      {action}
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="text-muted-foreground px-4 py-4 text-center text-sm"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border -mx-1 h-px", className)}
      {...props}
    />
  );
}

/** The menu-row recipe, exported so a row OUTSIDE a `Command` is the same row. */
const commandItemVariants = cva(
  // `min-h-8` is a stated control height, not one derived from font metrics, and
  // a row whose content wraps still grows past it.
  "[&_svg:not([class*='text-'])]:text-muted-foreground relative flex min-h-8 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      highlight: {
        // cmdk owns the highlight inside a list, marking the row it has selected.
        selected:
          "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
        // A standalone row answers to the pointer instead, and must span its panel.
        hover: "w-full hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        // A palette row, dense because the list is long.
        default: "",
        // A chooser row, where the list IS the page.
        lg: "min-h-11 gap-3 rounded-lg px-2.5 py-2",
      },
    },
    defaultVariants: { highlight: "selected", size: "default" },
  },
);

function CommandItem({
  className,
  size,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> &
  Pick<VariantProps<typeof commandItemVariants>, "size">) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(commandItemVariants({ size }), className)}
      {...props}
    />
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  commandItemVariants,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
