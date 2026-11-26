/**
 * Why VTEX refused the order ingest's key, from the ingest's error text
 * (`VTEX <status> …`, `VTEX 403 <METHOD> <path>` when it names the request).
 */

export type VtexPermission = "oms" | "hook";

export type VtexRejection =
  | { kind: "credentials" }
  | { kind: "permission"; missing: VtexPermission[] };

const ALL: VtexPermission[] = ["oms", "hook"];

const permissionOf = (path: string): VtexPermission | undefined =>
  path.startsWith("/api/oms")
    ? "oms"
    : /^\/api\/orders\/(hook|feed)/.test(path)
      ? "hook"
      : undefined;

/** Null when the error isn't VTEX refusing the key. */
export function vtexRejection(message: string): VtexRejection | null {
  const match = /^VTEX (401|403)\b(?:.*?(\/api\/\S+))?/.exec(message);
  if (!match) return null;
  if (match[1] === "401") return { kind: "credentials" };
  const one = match[2] ? permissionOf(match[2]) : undefined;
  // An ingest that doesn't name the request: every role it needs.
  return { kind: "permission", missing: one ? [one] : ALL };
}
