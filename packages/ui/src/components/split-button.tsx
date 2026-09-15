"use client";

import type * as React from "react";
import { ChevronDown } from "@untitledui/icons";

import { INSET_FOCUS_RING } from "../lib/focus-ring.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import { ButtonGroup } from "./button-group.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { Spinner } from "./spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

type ButtonProps = React.ComponentProps<typeof Button>;

export interface SplitButtonMenuItem {
  /** Stable identity for the item; also its React key. */
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tooltip?: string;
  /** Rendered before the label. */
  icon?: React.ReactNode;
}

export interface SplitButtonProps {
  label: string;
  onClick?: () => void;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  /**
   * Disables the primary half ONLY. The menu half stays operable so a control
   * whose main action is unavailable ("Up to date") can still offer actions.
   */
  disabled?: boolean;
  /** Shows a spinner in the primary half and swallows its clicks. */
  loading?: boolean;
  /** Breathing brightness on the whole control; static dimming without motion. */
  pulse?: boolean;
  /** Tooltip on the primary half — shown even while it is disabled. */
  tooltip?: string;
  icon?: React.ReactNode;
  /** With no items the chevron half is not rendered at all. */
  items?: SplitButtonMenuItem[];
  /** Accessible name for the chevron trigger. Required: this package is i18n-free. */
  menuAriaLabel: string;
  className?: string;
  /** Responsive visibility for the primary label; its accessible name remains. */
  labelClassName?: string;
}

function SplitButtonMenuEntry({ item }: { item: SplitButtonMenuItem }) {
  const entry = (
    <DropdownMenuItem
      disabled={item.disabled}
      onSelect={() => {
        item.onSelect();
      }}
    >
      {item.icon}
      {item.label}
    </DropdownMenuItem>
  );

  if (!item.tooltip) {
    return entry;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{entry}</TooltipTrigger>
      <TooltipContent side="right">{item.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** A primary action with an attached dropdown half — `[ Primary | v ]`. Without
 *  `items` it collapses to a plain button (same rounding as `Button`); with
 *  them the halves share one control and only the primary honours `disabled`.
 *  Every focusable part wears {@link INSET_FOCUS_RING}, because this lives in a
 *  panel header where an outset ring is clipped and a ring on one half would
 *  overlap the other; a disabled primary moves focus to its tooltip wrapper, so
 *  that span carries the ring too. */
export function SplitButton({
  label,
  onClick,
  variant = "default",
  size = "default",
  disabled = false,
  loading = false,
  pulse = false,
  tooltip,
  icon,
  items,
  menuAriaLabel,
  className,
  labelClassName,
}: SplitButtonProps) {
  const hasMenu = (items?.length ?? 0) > 0;
  /**
   * The shared inset ring is the `ring` token, which is picked to contrast with
   * the PAGE — so on a filled button, whose fill is that same light-on-dark
   * relationship inverted, it disappears into the button. currentColor is the
   * one value guaranteed to contrast with a button's own background, so the
   * filled variant rings in its own text colour.
   */
  const focusRing = cn(
    INSET_FOCUS_RING,
    variant === "default" && "focus-visible:inset-ring-current",
  );

  const primary = (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      aria-label={label}
      aria-busy={loading || undefined}
      // Loading dims nothing, so guard the handler against a double-fire.
      onClick={loading ? undefined : onClick}
      className={cn(
        focusRing,
        hasMenu && "rounded-r-none border-r border-current/20",
      )}
    >
      {loading ? <Spinner size="xs" /> : icon}
      <span className={labelClassName}>{label}</span>
    </Button>
  );

  return (
    <ButtonGroup
      className={cn(
        pulse &&
          "animate-pulse-brightness motion-reduce:animate-none motion-reduce:opacity-80",
        className,
      )}
    >
      {tooltip ? (
        <Tooltip>
          {/* Wrapper provides layout & focus styling. When primary is disabled, tabIndex=0
              makes the wrapper focusable so tooltip is reachable via keyboard. */}
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex rounded-lg outline-none",
                focusRing,
                disabled && "cursor-not-allowed",
              )}
              tabIndex={disabled ? 0 : undefined}
              role={disabled ? "button" : undefined}
              aria-disabled={disabled || undefined}
            >
              {primary}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        primary
      )}

      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant={variant}
              size={size}
              aria-label={menuAriaLabel}
              className={cn("has-[>svg]:px-2", focusRing)}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {items?.map((item) => (
              <SplitButtonMenuEntry key={item.key} item={item} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </ButtonGroup>
  );
}
