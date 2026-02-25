/**
 * MCP client factory for the Mesh /mcp/self endpoint.
 *
 * Provides:
 * - createMeshSelfClient: connect to Mesh's self-management MCP endpoint
 * - callMeshTool: call a tool and parse the text response
 * - getOrganizationId: retrieve the active organization ID from the Mesh session
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Create an MCP client connected to the Mesh /mcp/self endpoint.
 *
 * Authentication is done via Bearer token in the Authorization header.
 */
export async function createMeshSelfClient(
  meshUrl: string,
  apiKey: string,
): Promise<Client> {
  const client = new Client({ name: "deco-link", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("/mcp/self", meshUrl),
    { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } },
  );
  await client.connect(transport);
  return client;
}

/**
 * Call a tool on a Mesh MCP client and return the parsed result.
 *
 * Extracts the text content from the MCP response, JSON.parses it, and
 * returns the parsed value. Throws if the response is an error.
 */
export async function callMeshTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await client.callTool({ name: toolName, arguments: args });

  if (response.isError) {
    const errText =
      Array.isArray(response.content) && response.content.length > 0
        ? ((response.content[0] as { text?: string }).text ??
          String(response.content[0]))
        : "Unknown error";
    throw new Error(`Tool ${toolName} returned an error: ${errText}`);
  }

  if (!Array.isArray(response.content) || response.content.length === 0) {
    throw new Error(`Tool ${toolName} returned empty content`);
  }

  const first = response.content[0] as { type?: string; text?: string };
  if (first.type !== "text" || !first.text) {
    throw new Error(
      `Tool ${toolName} returned non-text content: ${first.type}`,
    );
  }

  try {
    return JSON.parse(first.text);
  } catch {
    // Some tools return plain strings; return as-is
    return first.text;
  }
}

/** Shape of the Better Auth session response */
interface BetterAuthSession {
  session?: {
    activeOrganizationId?: string | null;
    organizationId?: string | null;
  };
  user?: {
    id?: string;
  };
}

/** Shape of an organization membership list */
interface OrganizationMembership {
  organizationId?: string;
  organization?: { id?: string };
}

/**
 * Get the active organization ID for the authenticated user.
 *
 * Calls GET /api/auth/session first. If activeOrganizationId is present, use it.
 * Otherwise, call GET /api/auth/organization/list to find the first organization.
 * Throws with a clear message if no organization is found.
 */
/** Organization info returned by getOrganization */
export interface OrgInfo {
  id: string;
  slug: string;
}

/**
 * Get the active organization for the authenticated user.
 *
 * Returns both id and slug, needed for constructing Mesh UI URLs.
 */
export async function getOrganization(
  meshUrl: string,
  apiKey: string,
): Promise<OrgInfo> {
  // Fetch the full organization list (includes slug)
  const orgsRes = await fetch(`${meshUrl}/api/auth/organization/list`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (orgsRes.ok) {
    const orgs = (await orgsRes.json()) as Array<{
      id?: string;
      slug?: string;
      organization?: { id?: string; slug?: string };
    }>;
    if (Array.isArray(orgs) && orgs.length > 0) {
      const org = orgs[0];
      const id = org.id ?? org.organization?.id;
      const slug = org.slug ?? org.organization?.slug;
      if (id && slug) return { id, slug };
    }
  }

  // Fallback to getOrganizationId (no slug available)
  const id = await getOrganizationId(meshUrl, apiKey);
  return { id, slug: id }; // Use id as slug fallback
}

export async function getOrganizationId(
  meshUrl: string,
  apiKey: string,
): Promise<string> {
  // Fetch the current session
  const sessionRes = await fetch(`${meshUrl}/api/auth/get-session`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!sessionRes.ok) {
    throw new Error(
      `Failed to fetch Mesh session: ${sessionRes.status} ${sessionRes.statusText}`,
    );
  }

  const session = (await sessionRes.json()) as BetterAuthSession;

  const directOrgId =
    session?.session?.activeOrganizationId ?? session?.session?.organizationId;

  if (directOrgId) {
    return directOrgId;
  }

  // No active org in session — try listing organizations
  const orgsRes = await fetch(`${meshUrl}/api/auth/organization/list-members`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (orgsRes.ok) {
    const memberships = (await orgsRes.json()) as OrganizationMembership[];
    if (Array.isArray(memberships) && memberships.length > 0) {
      const orgId =
        memberships[0].organizationId ?? memberships[0].organization?.id;
      if (orgId) return orgId;
    }
  }

  // Try the standard Better Auth organizations endpoint
  const orgs2Res = await fetch(`${meshUrl}/api/auth/organization/list`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (orgs2Res.ok) {
    const orgs = (await orgs2Res.json()) as Array<{
      id?: string;
      organization?: { id?: string };
    }>;
    if (Array.isArray(orgs) && orgs.length > 0) {
      const orgId = orgs[0].id ?? orgs[0].organization?.id;
      if (orgId) return orgId;
    }
  }

  throw new Error(
    "No organization found for this Mesh account. " +
      "Please create an organization in Mesh before using 'deco link'.",
  );
}
