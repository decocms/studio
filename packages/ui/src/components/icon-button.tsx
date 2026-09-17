"use client";

import type * as React from "react";
import type { VariantProps } from "class-variance-authority";

import { Button, buttonVariants } from "./button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

type IconButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "aria-label" | "size"
> &
  Pick<VariantProps<typeof buttonVariants>, "size"> & {
    /**
     * What the button does, as a person would say it. Becomes the tooltip AND
     * the accessible name, so an icon-only control is never a mystery to
     * either a pointer or a screen reader.
     */
    label: string;
    /** Where the tooltip opens; defaults to above. */
    tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
  };

/**
 * An icon-only button that always explains itself.
 *
 * A bare icon in a `Button` is the design system's most common a11y miss: no
 * text, no tooltip, and an `aria-label` that someone remembers half the time.
 * This makes the label mandatory and wires both from the one prop.
 */
function IconButton({
  label,
  tooltipSide = "top",
  variant = "ghost",
  size = "icon-sm",
  children,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-slot="icon-button"
          aria-label={label}
          variant={variant}
          size={size}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

export { IconButton };
export type { IconButtonProps };
