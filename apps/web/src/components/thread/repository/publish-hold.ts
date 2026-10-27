import { useState } from "react";

/**
 * A hosted v8 Publish ends with a re-read of the content (the draft it just
 * emptied), and the dialog then closes on the published state with a fade.
 * Through all of it the dialog keeps showing the list it publishes, as it
 * was when Publish was clicked, rather than an empty review: the held list
 * is never dropped when the Publish ends, only released when it failed
 * (the dialog stays open with what the draft holds now). The dialog's
 * content unmounts once closed, so the next opening starts from the live
 * list. Every other Publish renders the live list, as before.
 */
export function shownPublishList<T>(
  /** The list as it was when Publish was clicked; null before any. */
  held: T | null,
  live: T,
  { hosted }: { hosted: boolean },
): T {
  return hosted && held !== null ? held : live;
}

/**
 * {@link shownPublishList} with its state: `hold` when Publish is clicked,
 * `release` when it failed.
 */
export function usePublishHold<T>(
  live: T,
  options: { hosted: boolean },
): { shown: T; hold: () => void; release: () => void } {
  const [held, setHeld] = useState<T | null>(null);
  return {
    shown: shownPublishList(held, live, options),
    hold: () => setHeld(options.hosted ? live : null),
    release: () => setHeld(null),
  };
}

/**
 * Whether the Publish dialog renders its body. A hosted v8 dialog keeps it
 * while it closes: its content stays mounted only through the close's fade
 * (Radix unmounts it after), so the body shows as it was, with the list it
 * published, never an empty dialog. Every other dialog drops its body as
 * soon as it closes, as before.
 */
export function publishBodyShown({
  open,
  hosted,
}: {
  open: boolean;
  hosted: boolean;
}): boolean {
  return open || hosted;
}
