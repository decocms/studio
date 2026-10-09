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
  /**
   * Every label the primary half can show across its states. When given, the
   * control keeps ONE width whatever its state, so a label swap (e.g.
   * "Review & Publish" → "Saving…") never shifts the header on the x axis:
   * every label is stacked in the same grid cell, only the active one visible,
   * so the primary is as wide as the widest; the icon slot is reserved; and the
   * chevron half stays mounted (disabled) while there are no `items`.
   * Measured by layout, not by a magic number, so it holds in every locale.
   */
  stableLabels?: string[];
  className?: string;
}

/** Icon-led padding per size: with {@link SplitButtonProps.stableLabels} the
 *  icon slot is always reserved, so the primary is always "icon-led". */
const STABLE_PADDING: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "px-3",
  sm: "px-2.5",
  xs: "px-2",
  lg: "px-4",
  xl: "px-5",
  icon: "",
  "icon-sm": "",
};

/**
 * The primary's content in stable-width mode: all labels share grid-area 1/1.
 * Inactive ones are `invisible` + `aria-hidden`, so they size the cell but are
 * neither painted nor exposed; the active one is the button's accessible name.
 */
function StableLabels({
  labels,
  label,
  leading,
}: {
  labels: string[];
  label: string;
  leading: React.ReactNode;
}) {
  // Deduped: two states (or locales) can share a string, and a repeated
  // active label would render twice — a duplicate key and a doubled name.
  const all = [...new Set([...labels, label])];
  return (
    <span className="grid items-center justify-items-center gap-[inherit]">
      {all.map((candidate) =>
        candidate === label ? (
          <span
            key={candidate}
            data-slot="split-button-label"
            className="col-start-1 row-start-1 inline-flex items-center gap-[inherit]"
          >
            {leading}
            {candidate}
          </span>
        ) : (
          <span
            key={candidate}
            aria-hidden="true"
            data-slot="split-button-label-reserve"
            className="invisible col-start-1 row-start-1 inline-flex items-center gap-[inherit]"
          >
            <span className="size-4 shrink-0" />
            {candidate}
          </span>
        ),
      )}
    </span>
  );
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
  stableLabels,
  className,
}: SplitButtonProps) {
  const hasMenu = (items?.length ?? 0) > 0;
  const stable = stableLabels !== undefined;
  const leading = loading ? <Spinner size="xs" /> : icon;
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
      aria-busy={loading || undefined}
      // Loading dims nothing, so guard the handler against a double-fire.
      onClick={loading ? undefined : onClick}
      className={cn(
        focusRing,
        (hasMenu || stable) && "rounded-r-none border-r border-current/20",
        stable && STABLE_PADDING[size ?? "default"],
      )}
    >
      {stable ? (
        <StableLabels labels={stableLabels} label={label} leading={leading} />
      ) : (
        <>
          {leading}
          {label}
        </>
      )}
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
      ) : stable ? (
        // No actions right now, but the half keeps its place so the control
        // doesn't narrow (and the header shift) as the state changes.
        <Button
          type="button"
          variant={variant}
          size={size}
          disabled
          aria-label={menuAriaLabel}
          className={cn("has-[>svg]:px-2", focusRing)}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      ) : null}
    </ButtonGroup>
  );
}
