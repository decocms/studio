/**
 * True if an organization is soft-deleted (archived via `metadata.archived`).
 *
 * Better Auth is inconsistent about the shape of `metadata`: `organization.list()`
 * (and the `useListOrganizations` hook) returns it as a raw JSON **string**, while
 * `getFullOrganization()` returns it already parsed into an object. A naive
 * `org.metadata?.archived` check silently passes archived orgs through on the
 * string path, so callers must normalize. This helper handles both shapes.
 */
export function isOrgArchived(
  org: { metadata?: unknown } | null | undefined,
): boolean {
  const raw = org?.metadata;
  if (!raw) return false;
  try {
    const meta =
      typeof raw === "string"
        ? (JSON.parse(raw) as { archived?: boolean })
        : (raw as { archived?: boolean });
    return meta.archived === true;
  } catch {
    // Unparseable metadata — treat as not archived
    return false;
  }
}
