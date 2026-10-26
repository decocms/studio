/**
 * A hosted v8 Publish ends with a re-read of the content (the draft it just
 * emptied) before the dialog closes on the published state. Meanwhile the
 * dialog keeps showing the list it publishes, as it was when Publish
 * started, rather than going blank for the re-read. Every other Publish
 * renders the live list, as before.
 */
export function shownPublishList<T>(
  /** The list as it was when Publish started; null before any. */
  held: T | null,
  live: T,
  { hosted, publishing }: { hosted: boolean; publishing: boolean },
): T {
  return hosted && publishing && held !== null ? held : live;
}
