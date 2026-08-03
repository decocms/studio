/**
 * Minimal RFC-4180 CSV field escaping, shared by the system-prompt catalog
 * blocks (`<available-prompts>`, `<available-skills>`). Quotes a field only
 * when it contains a delimiter, quote, semicolon, or newline.
 */
export function csvField(s: string | null | undefined): string {
  if (s == null || s === "") return "";
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes(";")
  ) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}
