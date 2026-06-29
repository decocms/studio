/**
 * Per-request, non-cached system prompt content.
 *
 * Anything that varies between requests but is needed in the system layer
 * lives here — kept outside cached prefixes so it does not invalidate provider
 * prompt caches.
 */
export function buildCurrentContextPrompt(now: Date): string {
  const iso = now.toISOString();
  return `<current-context>
Current date: ${iso.slice(0, 10)}
Current time: ${iso.slice(11, 16)} UTC
</current-context>`;
}
