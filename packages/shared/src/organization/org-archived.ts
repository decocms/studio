/**
 * A Studio organization's `metadata` as an object. Better Auth stores it as a
 * JSON string and returns it unparsed from both `organization.list()` and
 * `getFullOrganization()`, so spreading it into a new object copies one key
 * per character. Unparseable or non-object metadata reads as empty.
 */
export function parseOrgMetadata(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** True if a Studio organization is soft-deleted via `metadata.archived`. */
export function isOrgArchived(
  org: { metadata?: unknown } | null | undefined,
): boolean {
  return parseOrgMetadata(org?.metadata).archived === true;
}

/** Thrown when a request explicitly targets a soft-deleted org; the web shell
 *  matches on it to show the archived screen. */
export const ORG_ARCHIVED_ERROR = "Organization is archived";
