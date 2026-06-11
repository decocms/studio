/**
 * FolderIcon — the macOS-style blue folder from the Figma Library design
 * (file qFc7wr91, node 7874:856): gradient back tab + gradient front body
 * with two hairline stripes. Inline SVG traced from the design asset, so it
 * scales crisply; brand blues are constant across themes (like a real
 * Finder folder).
 *
 * `glyph` renders a Finder-special-folder style mark centered on the body
 * (the design reserves this slot — node 7874:861) for well-known folders
 * like skills/outputs. `readOnly` adds a small view-only badge on the
 * corner — an eye (the Drive convention), not a lock: read-only sets are
 * public, a padlock would misread as "private".
 */

import { useId } from "react";
import type { ComponentType, SVGProps } from "react";
import { Eye } from "@untitledui/icons";

export function FolderIcon({
  glyph: Glyph,
  readOnly,
  ...props
}: {
  glyph?: ComponentType<SVGProps<SVGSVGElement>>;
  readOnly?: boolean;
} & SVGProps<SVGSVGElement>) {
  // Gradient ids must be unique per instance — folder cards render many of
  // these on one page and a hidden duplicate id can break url() references.
  const id = useId();
  const backId = `${id}-back`;
  const frontId = `${id}-front`;

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
        fill={`url(#${backId})`}
      />
      {/* front body */}
      <rect
        y="8.72"
        width="32"
        height="21"
        rx="2.566"
        fill={`url(#${frontId})`}
      />
      {/* top inner highlight */}
      <rect
        x="0.3"
        y="8.86"
        width="31.4"
        height="0.55"
        rx="0.275"
        fill="#FFFFFF"
        opacity="0.25"
      />
      {/* bottom stripes */}
      <rect y="25.81" width="32" height="0.552" fill="#84CDFB" />
      <rect y="27.05" width="32" height="0.552" fill="#84CDFB" />
      {/* well-known-folder glyph, embossed on the body (design's glyph blue) */}
      {Glyph && (
        <Glyph
          x={10.5}
          y={13.2}
          width={11}
          height={11}
          strokeWidth={2.2}
          style={{ color: "#014AC9", opacity: 0.55 }}
        />
      )}
      {/* read-only corner badge — eye = view-only (Drive convention) */}
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
      <defs>
        <linearGradient
          id={backId}
          x1="15.97"
          y1="2.55"
          x2="15.97"
          y2="9.53"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.3" stopColor="#4D87DF" />
          <stop offset="1" stopColor="#296FE8" />
        </linearGradient>
        <radialGradient
          id={frontId}
          cx="0"
          cy="0"
          r="10"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(1.6 0 0 2.1538 16 19.22)"
        >
          <stop stopColor="#72B6FA" />
          <stop offset="1" stopColor="#5BB1EF" />
        </radialGradient>
      </defs>
    </svg>
  );
}
