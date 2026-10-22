/* eslint-disable ban-memoization/ban-memoization */
"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "../lib/utils.ts";

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onPointerDown,
  onKeyDown,
  thumbLabel,
  thumbValueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Each thumb's accessible name (the root's `aria-label` doesn't reach the
   *  focusable `role="slider"` thumb). */
  thumbLabel?: string;
  /** What a screen reader says for the value, e.g. "40%". */
  thumbValueText?: string;
}) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center py-2 select-none data-[disabled]:opacity-50 data-[orientation=vertical]:px-2 data-[orientation=vertical]:py-0 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
      // Radix focuses the thumb on press; keep the ring for keyboard focus only.
      onPointerDown={(event) => {
        event.currentTarget.dataset.pointer = "";
        onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        delete event.currentTarget.dataset.pointer;
        onKeyDown?.(event);
      }}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1",
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "bg-primary absolute data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
          )}
        />
      </SliderPrimitive.Track>
      {/* The ::after pad grows the grab target to 40px without changing the knob. */}
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          // Only when given: Radix names each thumb of a range ("Minimum",
          // "Maximum") unless an `aria-label` key is passed, even undefined.
          {...(thumbLabel !== undefined ? { "aria-label": thumbLabel } : {})}
          {...(thumbValueText !== undefined
            ? { "aria-valuetext": thumbValueText }
            : {})}
          className="relative block size-4 shrink-0 cursor-grab rounded-full bg-white shadow-edge transition-transform duration-150 after:absolute after:-inset-3 after:rounded-full after:content-[''] hover:scale-110 focus-ring in-data-pointer:outline-none! active:scale-110 active:cursor-grabbing disabled:pointer-events-none motion-reduce:transition-none"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
