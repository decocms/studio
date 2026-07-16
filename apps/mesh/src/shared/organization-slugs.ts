/**
 * Organization slugs claimed by public first-segment routes.
 *
 * Studio's authenticated shell lives at `/$org`, so a public route such as
 * `/report/:domain` shadows every organization sub-route under the same first
 * segment. Keep this guard at the Better Auth boundary so direct auth API
 * calls, MCP tools, onboarding, and future clients cannot bypass it.
 */
export const RESERVED_ORGANIZATION_SLUGS: ReadonlySet<string> = new Set([
  ".well-known",
  "_admin",
  "api",
  "auth",
  "cli",
  "commerce-onboarding",
  "dbos-queue-depth",
  "health",
  "hosted-run-pending",
  "login",
  "mcp",
  "metrics",
  "oauth",
  "oauth-proxy",
  "onboarding",
  "org",
  "report",
  "reset-password",
]);

export function isReservedOrganizationSlug(slug: unknown): boolean {
  return (
    typeof slug === "string" &&
    RESERVED_ORGANIZATION_SLUGS.has(slug.trim().toLowerCase())
  );
}
