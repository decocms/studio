import type { CSSProperties } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

/**
 * The ONE spinner. Every "something is loading" indicator in the product is
 * this component — there is no second shape, and no `variant` for colour.
 *
 * Colour comes from `currentColor`, so a spinner takes the colour of the text
 * around it: inside a filled button it is the button's foreground, next to
 * muted copy it is muted. That is what makes one component serve every context
 * — the old palette variants (`fill-primary text-gray-200`) could not sit on a
 * primary button without disappearing into it, which is why call sites reached
 * for a spinning `Loading01` icon instead and the product ended up with two
 * spinners that looked nothing alike.
 *
 * `size` covers the common cases; anything else is a `className` with a
 * `size-*` utility, which wins over the variant through `twMerge`.
 */
const variants = cva("animate-spin shrink-0", {
  variants: {
    size: {
      "2xs": "size-3",
      xs: "size-4",
      sm: "size-6",
      default: "size-7",
      lg: "size-8",
      icon: "size-6",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

interface Props extends VariantProps<typeof variants> {
  className?: string;
  /** For a caller whose size is a runtime number rather than a class. */
  style?: CSSProperties;
  /** Announce this spinner as a live status under `label`.
   *
   *  OMITTED BY DEFAULT, which renders it `aria-hidden`. A spinner almost
   *  always sits beside text that already says what is happening ("Saving",
   *  "Preparing your workspace") or inside a container that is itself
   *  `role="status"` — and a nested live region is both wrong and, in tests, an
   *  ambiguous `getByRole("status")`. Pass this only where the spinner is the
   *  ONLY thing on screen. */
  label?: string;
}

export function Spinner({ size, className, style, label }: Props) {
  return (
    /* The svg IS the element — no wrapper. It replaces a plain icon at most
       call sites, so an extra box would change layout in flex rows. */
    <svg
      {...(label
        ? { role: "status", "aria-label": label }
        : { "aria-hidden": true })}
      className={cn(variants({ size }), className)}
      style={style}
      viewBox="0 0 100 101"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Track, then the arc that reads as motion. Both currentColor: the
          track is the same ink held back, so the pair can never clash. */}
      <path
        d="M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z"
        fill="currentColor"
        opacity="0.2"
      />
      <path
        d="M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z"
        fill="currentColor"
      />
    </svg>
  );
}
