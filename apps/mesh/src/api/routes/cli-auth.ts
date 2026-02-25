/**
 * CLI Authentication Route
 *
 * Server-side API key creation for the CLI (deco link).
 * Creates an API key with the user's organization embedded in metadata,
 * which the client-side Better Auth endpoint cannot do.
 *
 * Route: POST /api/cli/auth
 * Auth: Cookie-based session (from browser redirect)
 * Returns: { key: string }
 */

import { Hono } from "hono";
import { auth } from "../../auth";

const app = new Hono();

app.post("/auth", async (c) => {
  // Get session from cookies (sent by browser redirect)
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.session || !session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Get the user's active organization
  const orgId = session.session.activeOrganizationId;

  if (!orgId) {
    // Try to find the user's first organization
    const memberships = await auth.api.listOrganizations({
      headers: c.req.raw.headers,
    });

    const firstOrg = Array.isArray(memberships) ? memberships[0] : null;

    if (!firstOrg) {
      return c.json(
        {
          error:
            "No organization found. Please create an organization in Mesh first.",
        },
        400,
      );
    }

    // Set the active organization
    await auth.api.setActiveOrganization({
      headers: c.req.raw.headers,
      body: { organizationId: firstOrg.id },
    });

    // Create API key with org metadata
    const result = await auth.api.createApiKey({
      body: {
        name: "deco-link-cli",
        metadata: {
          organization: {
            id: firstOrg.id,
            slug: firstOrg.slug,
            name: firstOrg.name,
          },
        },
      },
      headers: c.req.raw.headers,
    });

    return c.json({ key: result.key });
  }

  // Get org details for metadata
  const org = await auth.api.getFullOrganization({
    headers: c.req.raw.headers,
    query: { organizationId: orgId },
  });

  const result = await auth.api.createApiKey({
    body: {
      name: "deco-link-cli",
      metadata: {
        organization: {
          id: orgId,
          slug: org?.slug,
          name: org?.name,
        },
      },
    },
    headers: c.req.raw.headers,
  });

  return c.json({ key: result.key });
});

export default app;
