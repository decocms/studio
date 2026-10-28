import {
  type BlogConnectionCandidate,
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
 * (`@decocms/shared/blog-connections`). Search Console is read when it is
 * ready and never waited for.
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
  gsc: BlogConnectionStatus;
}

async function blogConnections(
  ctx: StudioContext,
  organizationId: string,
): Promise<BlogConnections> {
  const { items } = await ctx.storage.connections.list(organizationId);
  const status = async (kind: BlogConnectionKind | "gsc") => {
    const connection = pickBlogConnection(kind, items);
    /** VTEX signs in with its keys; the Google ones have a sign-in to check. */
    const signedIn =
      kind !== "vtex" && connection ? await authorized(ctx, connection) : true;
    return blogConnectionStatus(kind, connection, signedIn);
  };
  const [vtex, ga4, gsc] = await Promise.all([
    status("vtex"),
    status("ga4"),
    status("gsc"),
  ]);
  return { vtex, ga4, gsc };
}

/** The ids the blog reads, by kind. Search Console only when it is ready. */
export interface BlogConnectionIds {
  vtex: string;
  ga4: string;
  gsc?: string;
}

/**
 * The connection ids, or a refusal naming the required ones that are not
 * ready. A Search Console that is not ready is left out, never refused.
 */
export async function requireBlogConnections(
  ctx: StudioContext,
  organizationId: string,
): Promise<BlogConnectionIds> {
  const { vtex, ga4, gsc } = await blogConnections(ctx, organizationId);
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
  return {
    vtex: vtex.connectionId,
    ga4: ga4.connectionId,
    ...(gsc.gap === null && gsc.connectionId ? { gsc: gsc.connectionId } : {}),
  };
}

/**
 * The connections as a grounding pass reads them: VTEX through the tools that
 * answer a writer's questions, GA4 and Search Console through all their
 * read-only ones.
 */
export function blogGroundingConnections(
  ids: BlogConnectionIds,
): GroundingConnection[] {
  return [
    { id: ids.vtex, label: "vtex", allow: VTEX_GROUNDING_TOOLS },
    { id: ids.ga4, label: "ga4" },
    ...(ids.gsc ? [{ id: ids.gsc, label: "gsc" }] : []),
  ];
}

/**
 * The connections a blogpost card's run reads, with the tools its key may call
 * on each: VTEX only through its grounding tools, the Google ones whole. Every
 * one the organization has, ready or not; the tools refuse what is not ready.
 *
 * A run's key reaches only the connections its agent aggregates, and a card's
 * agent is the Super Agent, which aggregates none of these. Without them its
 * grounding pass is denied on every call and reports nothing as if the store
 * had nothing to say.
 */
export function blogCardRunConnections(
  connections: readonly BlogConnectionCandidate[],
): { ids: string[]; limits: Record<string, string[]> } {
  const vtex = pickBlogConnection("vtex", connections);
  const google = [
    pickBlogConnection("ga4", connections),
    pickBlogConnection("gsc", connections),
  ];
  return {
    ids: [vtex, ...google]
      .filter((connection) => connection !== null)
      .map((connection) => connection.id),
    limits: vtex ? { [vtex.id]: [...VTEX_GROUNDING_TOOLS] } : {},
  };
}
