import { DECK } from "./tokens";

/**
 * The shared headline block at the top of a content slide — editorial treatment:
 * tiny soft-green uppercase eyebrow, weight-400 tight-tracked headline, and
 * the annotation as a muted side note (right column on desktop).
 */
export default function SlideHeader({
  eyebrow,
  headline,
  annotation,
  active,
}: {
  eyebrow?: string;
  headline: string;
  annotation?: string;
  active?: boolean;
}) {
  // Collapse any model-inserted line breaks — they land at awkward spots (e.g.
  // "…de IA⏎não chegam…"). Let the text wrap naturally to the column width.
  const text = headline.replace(/\s*\n\s*/g, " ");
  const show = active ? "true" : "false";
  return (
    // min(..., Nsvh) caps only kick in on short viewports (small phones,
    // landscape) so content slides compress instead of scrolling; desktop and
    // tall phones resolve to the original sizes.
    <header className="flex shrink-0 flex-col gap-[min(0.625rem,1svh)] px-5 pt-2 sm:gap-3 sm:px-10 lg:px-16">
      {eyebrow && (
        <p className="reveal deck-eyebrow" data-show={show}>
          {eyebrow}
        </p>
      )}
      <div className="flex flex-col gap-[min(0.625rem,1svh)] sm:flex-row sm:items-start sm:justify-between sm:gap-12">
        <h2
          className="reveal text-balance font-normal leading-[1.14] tracking-[-0.02em] text-[min(clamp(1.3125rem,4.8vw,2.5rem),2.9svh)] sm:text-[clamp(1.5rem,3.2vw,2.5rem)] lg:text-[2.25rem] lg:max-w-[20ch]"
          data-show={show}
          style={{ color: DECK.ink }}
        >
          {text}
        </h2>
        {annotation && (
          <p
            className="reveal max-w-[44ch] shrink-0 text-[min(13px,1.9svh)] leading-snug sm:pt-1 sm:text-[14px] sm:leading-relaxed"
            data-show={show}
            style={{
              color: DECK.muted,
              transitionDelay: active ? "90ms" : "0ms",
            }}
          >
            {annotation}
          </p>
        )}
      </div>
    </header>
  );
}
