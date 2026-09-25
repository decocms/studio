/**
 * The artwork for the project creation paths and the home's empty state.
 *
 * Drawn here rather than exported as assets for the same reason
 * `empty-state-illustrations.tsx` is: these are chrome, not content. They are
 * monochrome `currentColor` line work, so they inherit the surface they sit on
 * and are correct in both themes without a second file — and a card can tint
 * its whole scene by setting one text colour.
 *
 * Each scene is a literal picture of the thing being created: a storefront in
 * a browser, a repository graph feeding a folder, an awning over a shopping
 * bag, a page of measurements. They share a 96×64 frame so the four cards in
 * the dialog line up on the pixel, not by luck.
 */

const frame = {
  viewBox: "0 0 96 64",
  fill: "none",
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true as const,
} as const;

const line = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** A commit graph branching into the folder it becomes. */
export function RepositoryArt({ className }: { className?: string }) {
  return (
    <svg {...frame} className={className}>
      <path d="M22 46V22" {...line} opacity={0.7} />
      <circle cx="22" cy="18" r="4" {...line} opacity={0.8} />
      <circle cx="22" cy="50" r="4" {...line} opacity={0.8} />
      <path d="M22 32h14a6 6 0 0 1 6 6v4" {...line} opacity={0.6} />
      <circle cx="42" cy="46" r="4" {...line} opacity={0.7} />
      <path
        d="M56 22h9l3 4h14a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H56a3 3 0 0 1-3-3V25a3 3 0 0 1 3-3Z"
        {...line}
        opacity={0.75}
      />
      <path d="M53 34h32" {...line} opacity={0.5} />
    </svg>
  );
}

/** A plain open folder, empty. */
export function FolderArt({ className }: { className?: string }) {
  return (
    <svg {...frame} className={className}>
      <path
        d="M16 22a4 4 0 0 1 4-4h14l6 6h20a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V22Z"
        {...line}
        opacity={0.8}
      />
      <path d="M16 28h64" {...line} opacity={0.5} />
    </svg>
  );
}

/**
 * The home's empty state: the three things an org builds here, stacked the way
 * they would sit on a desk — a storefront behind, a phone leaning on it, a
 * price tag in front.
 *
 * Larger frame and slightly heavier line than the card scenes: this one is
 * looked AT, not glanced at, and it is the only thing on an otherwise blank
 * page.
 */
export function EmptyProjectsArt({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 220 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      {/* The storefront, furthest back and faintest. */}
      <g opacity={0.55}>
        <rect x="46" y="16" width="128" height="88" rx="8" {...line} />
        <path d="M46 34h128" {...line} opacity={0.6} />
        <circle cx="56" cy="25" r="2" fill="currentColor" opacity={0.6} />
        <circle cx="64" cy="25" r="2" fill="currentColor" opacity={0.45} />
        <circle cx="72" cy="25" r="2" fill="currentColor" opacity={0.3} />
        <rect
          x="58"
          y="44"
          width="104"
          height="24"
          rx="4"
          {...line}
          opacity={0.5}
        />
        <rect
          x="58"
          y="76"
          width="30"
          height="16"
          rx="3"
          {...line}
          opacity={0.4}
        />
        <rect
          x="95"
          y="76"
          width="30"
          height="16"
          rx="3"
          {...line}
          opacity={0.3}
        />
        <rect
          x="132"
          y="76"
          width="30"
          height="16"
          rx="3"
          {...line}
          opacity={0.22}
        />
      </g>

      {/* The app, leaning in from the left. */}
      <g transform="rotate(-8 44 92)">
        <rect
          x="22"
          y="52"
          width="44"
          height="76"
          rx="8"
          {...line}
          fill="var(--color-background)"
        />
        <path d="M37 60h14" {...line} opacity={0.5} />
        <rect
          x="29"
          y="68"
          width="30"
          height="20"
          rx="3"
          {...line}
          opacity={0.45}
        />
        <path d="M29 96h30M29 104h20" {...line} opacity={0.35} />
        <rect
          x="29"
          y="112"
          width="30"
          height="8"
          rx="4"
          {...line}
          opacity={0.5}
        />
      </g>

      {/* The tag, closest and most defined. */}
      <g transform="rotate(10 168 104)">
        <path
          d="M150 92h30a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6h-30a6 6 0 0 1-6-6V98a6 6 0 0 1 6-6Z"
          {...line}
          fill="var(--color-background)"
        />
        <circle cx="165" cy="104" r="3.5" {...line} />
        <path d="M152 116h26M152 124h16" {...line} opacity={0.45} />
      </g>
    </svg>
  );
}
