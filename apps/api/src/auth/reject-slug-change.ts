import { APIError } from "better-auth/api";

/**
 * Better Auth's own `/organization/update` endpoint accepts an arbitrary
 * `slug` in its update payload. Studio's ORGANIZATION_UPDATE tool and the
 * settings UI never send one, but a caller with org-update permission can
 * still hit Better Auth's endpoint directly (authClient.organization.update,
 * or the raw REST route) and rename the org. The slug anchors every
 * /api/:org/... and /$org/... URL, so this rejects any attempt to change it,
 * matching the immutability guarantee the rest of the codebase assumes.
 */
export function rejectOrganizationSlugChange(
  currentSlug: string,
  nextSlug: unknown,
): void {
  if (typeof nextSlug !== "string" || nextSlug === currentSlug) return;
  throw new APIError("BAD_REQUEST", {
    message: "Organization slug cannot be changed after creation.",
  });
}
