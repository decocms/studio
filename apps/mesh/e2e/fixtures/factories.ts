/**
 * API factories for setting up test state without driving the UI.
 *
 * Rule: if there is an API path, factories go through it. Direct SQL via
 * `connectDevDb()` (see `db.ts`) is reserved for assertions and for state
 * that has no API (e.g., seeding `organization_domains`).
 *
 * Add a factory here when a second spec needs it. One-off setup in a single
 * spec is fine to keep inline.
 */

import type { APIRequestContext } from "@playwright/test";

/**
 * Invite a member to an organization via Better Auth's organization plugin.
 *
 * The web app uses `authClient.organization.inviteMember(...)`; the REST
 * surface is `POST /api/auth/organization/invite-member`. We hit the REST
 * endpoint directly so factories don't depend on the web bundle.
 *
 * Requires that `request` has the cookies of an authed member with
 * permission to invite (typically the org owner returned by signUpViaApi).
 */
export async function inviteMember(
  request: APIRequestContext,
  args: {
    organizationId: string;
    email: string;
    role?: "member" | "admin" | "owner";
  },
): Promise<{ invitationId: string }> {
  const res = await request.post("/api/auth/organization/invite-member", {
    data: {
      organizationId: args.organizationId,
      email: args.email,
      role: args.role ?? "member",
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`inviteMember: HTTP ${res.status()} — ${body}`);
  }
  const body = (await res.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const invitationId = body.id ?? body.invitation?.id;
  if (!invitationId) {
    throw new Error(
      `inviteMember: response did not include invitation id (got ${JSON.stringify(body)})`,
    );
  }
  return { invitationId };
}
