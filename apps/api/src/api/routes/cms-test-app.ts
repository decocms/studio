/**
 * A Hono app with the hosted CMS routes over in-memory buckets and tables,
 * for the route and lifecycle tests.
 */

import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { memoryDraftTable, memoryRecordStore } from "@/hosted/cms-test-helpers";
import { memoryDeliveryStore, memoryKv } from "@/hosted/hosted-test-helpers";
import type { Env } from "../hono-env";
import { createCmsRoutes } from "./cms";

const ORG = "org_1";

export interface CmsTestCaller {
  userId: string | null;
  method?: StudioContext["auth"]["method"];
  onBehalfOf?: boolean;
  /** The organizations the caller is admitted to (default: `ORG`). */
  orgs?: string[];
}

export function cmsTestApp(
  options: {
    hasCms?: boolean;
    configured?: boolean;
    sites?: Record<string, string>;
    /** Organizations whose writes are blocked. */
    blocked?: string[];
  } = {},
) {
  const delivery = memoryDeliveryStore();
  const records = memoryRecordStore();
  const table = memoryDraftTable();
  const patches: Array<{ set: Record<string, unknown>; unset: string[] }> = [];
  const project = {
    id: "p1",
    organization_id: ORG,
    metadata: { previewServerUrl: "https://Preview.Acme.com/x" } as Record<
      string,
      unknown
    >,
  };
  const sites = options.sites ?? { acme: ORG };
  let caller: CmsTestCaller = { userId: "usr_ana", method: "session" };
  const context = (): StudioContext =>
    ({
      // /api/cms/:site names no organization: the gates resolve it.
      auth: {
        ...(caller.userId ? { user: { id: caller.userId } } : {}),
        ...(caller.method ? { method: caller.method } : {}),
        ...(caller.onBehalfOf ? { onBehalfOf: true } : {}),
      },
      storage: {
        kv: memoryKv(),
        virtualMcps: {
          findById: async (id: string) => (id === project.id ? project : null),
          patchMetadata: async (p: {
            set: Record<string, unknown>;
            unset: string[];
          }) => {
            patches.push({ set: p.set, unset: p.unset });
            return true;
          },
        },
        orgSites: {
          getBySlug: async (slug: string) =>
            Object.hasOwn(sites, slug)
              ? {
                  slug,
                  organizationId: sites[slug],
                  projectId: slug === "acme" ? "p1" : null,
                }
              : null,
        },
      },
    }) as unknown as StudioContext;
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("studioContext", context());
    await next();
  });
  // Mounted as app.ts mounts it, at /api/cms (tests call /cms).
  app.route(
    "/cms",
    createCmsRoutes({
      buckets: () =>
        options.configured === false
          ? null
          : { store: delivery.store, purge: delivery.purge, records },
      draftTable: () => table,
      siteDomains: async () => ["www.acme.com"],
      hasCms: async () => options.hasCms ?? true,
      admit: async (c, organizationId) => {
        if (!(caller.orgs ?? [ORG]).includes(organizationId)) return false;
        c.var.studioContext.organization = {
          id: organizationId,
          slug: `${organizationId}-slug`,
          name: organizationId,
        };
        return true;
      },
      isBlocked: async (_c, organizationId) =>
        (options.blocked ?? []).includes(organizationId),
    }),
  );
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    raw?: string,
  ) => {
    const res = await app.request(`/cms/${path}`, {
      method,
      ...(body !== undefined || raw !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: raw ?? JSON.stringify(body),
          }
        : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json as Record<string, any> };
  };
  const rpc = (
    site: string,
    draft: string,
    method: string,
    params: unknown = {},
  ) =>
    call("POST", `${site}/drafts/${encodeURIComponent(draft)}/rpc`, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
  return {
    app,
    delivery,
    records,
    table,
    patches,
    project,
    call,
    rpc,
    as: (next: CmsTestCaller) => {
      caller = next;
    },
  };
}
