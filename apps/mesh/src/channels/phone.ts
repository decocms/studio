/**
 * Canonical phone form used for matching/storage: digits only, no '+', spaces,
 * or punctuation. WhatsApp/WABA delivers the sender `from` in E.164 **without**
 * a leading '+', so we normalize both the inbound number and any UI-entered
 * number to the same digit string before comparing or persisting.
 */
export function canonicalizePhone(input: string | null | undefined): string {
  return (input ?? "").replace(/\D/g, "");
}

/** Display form: leading '+' on the canonical digits (or "" when empty). */
export function displayPhone(canonical: string): string {
  return canonical ? `+${canonical}` : "";
}

/** Mask all but the last 4 digits for previews (e.g. "+•••••••1234"). */
export function maskPhone(canonical: string): string {
  if (!canonical) return "";
  if (canonical.length <= 4) return `+${canonical}`;
  return `+${"•".repeat(Math.max(2, canonical.length - 4))}${canonical.slice(-4)}`;
}
