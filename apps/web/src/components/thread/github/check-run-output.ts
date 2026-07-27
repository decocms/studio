/**
 * Pure helpers for a check run's `output`. GitHub splits the detail into
 * `summary` (e.g. URL/verdict) and `text` (e.g. the step table) and renders
 * BOTH; joining them keeps the detailed section from being dropped when a
 * summary is present.
 */

export interface CheckRunOutput {
  title: string | null;
  summary: string | null;
  text: string | null;
}

/** Trimmed `summary` + `text`, joined with a blank line; "" when both empty. */
export function joinCheckOutput(
  output: { summary?: string | null; text?: string | null } | null | undefined,
): string {
  return [output?.summary?.trim(), output?.text?.trim()]
    .filter(Boolean)
    .join("\n\n");
}
