import {
  type BlogConnectionKind,
  type BlogConnectionStatus,
  blogConnectionStatus,
  blogConnectionsMissingMessage,
  pickBlogConnection,
} from "@decocms/shared/blog-connections";
import type { ConnectionEntity } from "@decocms/shared/sdk/types";
import type { StudioContext } from "../../core/studio-context";
import { canRefresh } from "../../oauth/token-refresh";
import { DownstreamTokenStorage } from "../../storage/downstream-token";
import { type GroundingConnection, VTEX_GROUNDING_TOOLS } from "./site-tools";

/**
 * The blog runs on the organization's VTEX and GA4 connections and refuses to
 * start without them — the same rule the browser shows before anyone clicks
 * (`@decocms/shared/blog-connections`).
 *
 * A product requirement, not an authorization check: whether the caller may
 * act for this organization was settled by `ctx.access.check()` first.
 */

/** Signed in, without spending a refresh: a stored token that still works. */
async function authorized(
  ctx: StudioContext,
  connection: ConnectionEntity,
): Promise<boolean> {
  if (connection.connection_token) return true;
  const tokens = new DownstreamTokenStorage(ctx.db, ctx.vault);
  const token = await tokens.get(connection.id);
  return !!token && (!tokens.isExpired(token) || canRefresh(token));
}

interface BlogConnections {
  vtex: BlogConnectionStatus;
  ga4: BlogConnectionStatus;
}

async function blogConnections(
  ctx: StudioContext,
  organizationId: string,
): Promise<BlogConnections> {
  const { items } = await ctx.storage.connections.list(organizationId);
  const status = async (kind: BlogConnectionKind) => {
    const connection = pickBlogConnection(kind, items);
    /** VTEX signs in with its keys; only GA4 has a sign-in to check. */
    const signedIn =
      kind === "ga4" && connection ? await authorized(ctx, connection) : true;
    return blogConnectionStatus(kind, connection, signedIn);
  };
  const [vtex, ga4] = await Promise.all([status("vtex"), status("ga4")]);
  return { vtex, ga4 };
}

/** The two connection ids, or a refusal naming the ones that are not ready. */
export async function requireBlogConnections(
  ctx: StudioContext,
  organizationId: string,
): Promise<{ vtex: string; ga4: string }> {
  const { vtex, ga4 } = await blogConnections(ctx, organizationId);
  const missing = (
    [
      ["vtex", vtex],
      ["ga4", ga4],
    ] as const
  )
    .filter(([, status]) => status.gap !== null || !status.connectionId)
    .map(([kind]) => kind);
  if (missing.length > 0 || !vtex.connectionId || !ga4.connectionId) {
    throw new Error(
      `${blogConnectionsMissingMessage(missing)}. Connect them in the organization's connections before generating.`,
    );
  }
  return { vtex: vtex.connectionId, ga4: ga4.connectionId };
}

/**
 * The two connections as a grounding pass reads them: VTEX through the tools
 * that answer a writer's questions, GA4 through all its read-only ones.
 */
export function blogGroundingConnections(ids: {
  vtex: string;
  ga4: string;
}): GroundingConnection[] {
  return [
    { id: ids.vtex, label: "vtex", allow: VTEX_GROUNDING_TOOLS },
    { id: ids.ga4, label: "ga4" },
  ];
}
