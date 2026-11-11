/**
 * A preview's pending bar, at the top of its `relative` canvas: an asymptotic
 * "commit ramp" — brand lime fill over a transparent track, no strip across
 * the site, just the moving edge itself, with a soft same-color glow for
 * presence on busy content.
 */
export function PreviewProgressBar() {
  return (
    <div
      data-testid="preview-progress"
      className="absolute inset-x-0 top-0 z-40 h-1 overflow-hidden"
    >
      <div className="absolute inset-y-0 left-0 rounded-r-full bg-brand shadow-[0_0_6px] shadow-brand/60 animate-preview-ramp" />
    </div>
  );
}
