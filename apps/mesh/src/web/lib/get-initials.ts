/**
 * Word-initials for an avatar fallback: "John Doe" -> "JD", capped at two
 * letters. Falls back to "?" for empty/missing names. (Distinct from Avatar's
 * built-in first-two-chars fallback, which would yield "JO".)
 */
export function getInitials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
