/**
 * FolderIcon: the Finder-style folder from the Figma Library design, in the theme's neutral ramp.
 *
 * `glyph` renders a Finder-special-folder style mark centered on the body
 * (the design reserves this slot — node 7874:861) for well-known folders
 * like skills/outputs. `readOnly` adds a small view-only badge on the
 * corner — an eye (the Drive convention), not a lock: read-only sets are
 * public, a padlock would misread as "private".
 *
 * `tone`: a firmer grey for folders people make, a lighter one for system folders.
 *
 * `sheets` draws up to three pages peeking over the front body — the one thing
 * a closed folder can honestly say about itself from a listing: it has
 * something in it. Drawn between the back tab and the front body so they read
 * as being INSIDE, and fanned rather than stacked so a full folder looks full
 * at a glance instead of holding one thick page.
 */

import type { ComponentType, SVGProps } from "react";
import { Eye } from "@untitledui/icons";

const TONES = {
  default: {
    back: "fill-neutral-5",
    front: "fill-neutral-4",
    stripe: "fill-neutral-5",
  },
  system: {
    back: "fill-neutral-4",
    front: "fill-neutral-3",
    stripe: "fill-neutral-4",
  },
} as const;

export type FolderTone = keyof typeof TONES;

/** How far each page leans, in degrees. Three is the most that reads as a fan
 *  rather than a mess at 32px, which is why `sheets` is clamped to it. */
const SHEET_ANGLES = [-7, 0, 7] as const;

export function FolderIcon({
  glyph: Glyph,
  readOnly,
  tone = "default",
  sheets = 0,
  ...props
}: {
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  readOnly?: boolean;
  tone?: FolderTone;
  /** Pages peeking out of the folder, 0 to 3. */
  sheets?: number;
} & SVGProps<SVGSVGElement>) {
  const colors = TONES[tone];

  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      {/* back tab */}
      <path
        d="M2.53738 2.55C1.13602 2.55 0 3.68602 0 5.08738V11.535H31.931V7.65326C31.931 6.23616 30.7822 5.08738 29.3651 5.08738H14.7681L13.8775 5.02542C13.3886 4.99141 12.9197 4.81809 12.5261 4.52596L10.7726 3.22419C10.1828 2.78638 9.46784 2.55 8.73334 2.55H2.53738Z"
        className={colors.back}
      />
      {/* pages inside, peeking over the front body's top edge */}
      {SHEET_ANGLES.slice(0, Math.min(Math.max(sheets, 0), 3)).map((angle) => (
        <rect
          key={angle}
          x="9"
          y="3.4"
          width="14"
          height="12"
          rx="1.2"
          /* Pages must stay lighter than the body; the background token goes black in dark and reads as a slot. */
          className="fill-neutral-1 stroke-neutral-5 dark:fill-neutral-7 dark:stroke-neutral-6"
          strokeWidth="0.7"
          transform={`rotate(${angle} 16 12)`}
        />
      ))}
      {/* front body */}
      <rect
        y="8.72"
        width="32"
        height="21"
        rx="2.566"
        className={colors.front}
      />
      {/* bottom stripes */}
      <rect y="25.81" width="32" height="0.552" className={colors.stripe} />
      <rect y="27.05" width="32" height="0.552" className={colors.stripe} />
      {/* well-known-folder glyph, embossed on the body */}
      {Glyph && (
        <Glyph
          x={10.5}
          y={13.2}
          width={11}
          height={11}
          strokeWidth={2.2}
          className="text-muted-foreground"
        />
      )}
      {/* read-only corner badge: eye = view-only (Drive convention) */}
      {readOnly && (
        <>
          <circle
            cx="25.5"
            cy="25.5"
            r="6.2"
            strokeWidth="1"
            className="fill-background stroke-border"
          />
          <Eye
            x={22.1}
            y={22.1}
            width={6.8}
            height={6.8}
            strokeWidth={2.2}
            className="text-muted-foreground"
          />
        </>
      )}
    </svg>
  );
}
