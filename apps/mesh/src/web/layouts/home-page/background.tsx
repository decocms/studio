/**
 * Faded decorative graphics for the home, rendered at their natural viewBox
 * size — crisp at any zoom since SVG. Light/dark variants swap via Tailwind.
 *
 * `variant`:
 *  - "corners" (default): top-left + bottom-right corner motifs.
 *  - "left": a single accent hugging the LEFT edge, vertically centered and
 *    faint, so it never sits behind the heading text (used by the redesign
 *    home where the brief reads over it).
 */

const TOP_LEFT_WIDTH_PX = 420; // ~50% of viewBox (834)
const BOTTOM_RIGHT_WIDTH_PX = 305; // ~50% of viewBox (610)
const LEFT_WIDTH_PX = 360;

export function HomeBackground({
  variant = "corners",
}: {
  variant?: "corners" | "left";
}) {
  if (variant === "left") {
    return (
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <img
          src="/home/bg-top-left.svg"
          alt=""
          className="absolute top-1/2 left-0 h-auto -translate-x-1/3 -translate-y-1/2 select-none opacity-[0.18] dark:hidden"
          style={{ width: LEFT_WIDTH_PX }}
        />
        <img
          src="/home/bg-top-left-dark.svg"
          alt=""
          className="absolute top-1/2 left-0 hidden h-auto -translate-x-1/3 -translate-y-1/2 select-none opacity-[0.18] dark:block"
          style={{ width: LEFT_WIDTH_PX }}
        />
      </div>
    );
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <img
        src="/home/bg-top-left.svg"
        alt=""
        className="absolute top-0 left-0 h-auto select-none opacity-20 dark:hidden"
        style={{ width: TOP_LEFT_WIDTH_PX }}
      />
      <img
        src="/home/bg-top-left-dark.svg"
        alt=""
        className="absolute top-0 left-0 hidden h-auto select-none opacity-20 dark:block"
        style={{ width: TOP_LEFT_WIDTH_PX }}
      />
      <img
        src="/home/bg-bottom-right.svg"
        alt=""
        className="absolute bottom-0 right-0 h-auto select-none opacity-20 dark:hidden"
        style={{ width: BOTTOM_RIGHT_WIDTH_PX }}
      />
      <img
        src="/home/bg-bottom-right-dark.svg"
        alt=""
        className="absolute bottom-0 right-0 hidden h-auto select-none opacity-20 dark:block"
        style={{ width: BOTTOM_RIGHT_WIDTH_PX }}
      />
    </div>
  );
}
