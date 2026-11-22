"use client";

import type * as React from "react";
import { ChevronLeft, ChevronRight } from "@untitledui/icons";
import { DayPicker } from "react-day-picker";

import { cn } from "../lib/utils.ts";
import { buttonVariants } from "./button.tsx";

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-(--space-s)", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-(--space-xs)",
        month: "flex flex-col gap-(--space-m)",
        caption: "flex justify-center pt-1 relative items-center w-full",
        caption_label: "text-s font-medium",
        nav: "flex items-center gap-(--space-xxs)",
        nav_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-7 p-0 text-muted-foreground hover:text-foreground",
        ),
        nav_button_previous: "absolute left-1",
        nav_button_next: "absolute right-1",
        table: "w-full border-collapse space-x-1",
        head_row: "flex",
        head_cell: "text-muted-foreground w-8 font-regular text-s",
        row: "flex w-full mt-(--space-xs)",
        cell: cn(
          "relative p-0 text-center text-s focus-within:relative focus-within:z-20 [&:has([aria-selected])]:bg-accent [&:has([aria-selected].day-range-end)]:rounded-r-s",
          props.mode === "range"
            ? "[&:has(>.day-range-end)]:rounded-r-s [&:has(>.day-range-start)]:rounded-l-s first:[&:has([aria-selected])]:rounded-l-s last:[&:has([aria-selected])]:rounded-r-s"
            : "[&:has([aria-selected])]:rounded-(--radius-s)",
        ),
        day: cn(
          buttonVariants({ variant: "ghost" }),
          "size-8 p-0 font-regular",
        ),
        day_range_start:
          "day-range-start aria-selected:bg-primary aria-selected:text-primary-foreground",
        day_range_end:
          "day-range-end aria-selected:bg-primary aria-selected:text-primary-foreground",
        day_selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        day_today:
          "bg-neutral-3 text-foreground aria-selected:bg-primary aria-selected:text-primary-foreground",
        day_outside:
          "day-outside text-muted-foreground aria-selected:text-muted-foreground",
        day_disabled: "text-neutral-6",
        day_range_middle:
          "aria-selected:bg-accent aria-selected:text-accent-foreground",
        day_hidden: "invisible",
        ...classNames,
      }}
      components={{
        IconLeft: ({ className, ...props }) => (
          <ChevronLeft className={cn("size-4", className)} {...props} />
        ),
        IconRight: ({ className, ...props }) => (
          <ChevronRight className={cn("size-4", className)} {...props} />
        ),
      }}
      {...props}
    />
  );
}

export { Calendar };
