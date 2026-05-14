/**
 * Faded decorative-tile background for the home. The PNG was exported
 * from the Figma reference and we tile it once at the top and bottom of
 * the page so the motifs read as accents rather than a busy repeating
 * pattern — closer to the original design than a hard repeat.
 */

export function HomeBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <img
        src="/home/bg-pattern.png"
        alt=""
        className="absolute top-0 left-0 w-full object-cover opacity-90"
        style={{ maxHeight: 280 }}
      />
      <img
        src="/home/bg-pattern.png"
        alt=""
        className="absolute bottom-0 left-0 w-full object-cover opacity-90 rotate-180"
        style={{ maxHeight: 280 }}
      />
    </div>
  );
}
