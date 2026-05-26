/**
 * Faded decorative corners for the home. Two SVGs (top-left and
 * bottom-right) anchored to their respective corners, rendered at their
 * natural viewBox size — no stretching or cropping by CSS, and crisp at
 * any zoom level since SVG. Light/dark variants swap via Tailwind.
 */

const TOP_LEFT_WIDTH_PX = 420; // ~50% of viewBox (834)
const BOTTOM_RIGHT_WIDTH_PX = 305; // ~50% of viewBox (610)

export function HomeBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <img
        src="/home/bg-top-left.svg"
        alt=""
        className="absolute top-0 left-0 h-auto select-none opacity-80 dark:hidden"
        style={{ width: TOP_LEFT_WIDTH_PX }}
      />
      <img
        src="/home/bg-top-left-dark.svg"
        alt=""
        className="absolute top-0 left-0 hidden h-auto select-none opacity-80 dark:block"
        style={{ width: TOP_LEFT_WIDTH_PX }}
      />
      <img
        src="/home/bg-bottom-right.svg"
        alt=""
        className="absolute bottom-0 right-0 h-auto select-none opacity-80 dark:hidden"
        style={{ width: BOTTOM_RIGHT_WIDTH_PX }}
      />
      <img
        src="/home/bg-bottom-right-dark.svg"
        alt=""
        className="absolute bottom-0 right-0 hidden h-auto select-none opacity-80 dark:block"
        style={{ width: BOTTOM_RIGHT_WIDTH_PX }}
      />
    </div>
  );
}
