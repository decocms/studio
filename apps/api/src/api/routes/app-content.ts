/**
 * Published decofile for mobile apps — anonymous, read-only, cacheable.
 *
 *   GET /api/:org/app-content/:virtualMcpId
 *
 * Always the default branch head: a draft branch is never served here (drafts
 * reach phones only through Eitri Play, in dev). Every gate — org flag
 * `app_content_delivery`, `cms` plan, project in the org, repository binding,
 * `.deco/app.json` with `publishedContent: true` — fails to the same 404 so
 * the route cannot be used to enumerate projects. Secret blocks (top-level or
 * nested) are stripped before anything is cached or served.
 *
 * `resolveOrgFromPath` lets anonymous callers through with the org resolved;
 * this route self-enforces its gates.
 */

import { isSecretBlock } from "@decocms/shared/decofile";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import { Hono, type Context } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { orgHasFeature } from "@/core/plan-feature-gate";
import { readAppManifest } from "@/app-content/manifest";
import { readDecofileAtSha } from "@/decofile/read-decofile";
import { createSingleFlight } from "@/decofile/single-flight";
import {
  contentClientForProjectRepo,
  repoErrorStatus,
  requireBranchHead,
} from "@/git-providers";
import type { Env } from "../hono-env";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import { clientIp, createWindowLimiter } from "../utils/rate-limit";

// Gates: org flag `app_content_delivery`, the `cms` plan, the virtual MCP in the org.
const VIRTUAL_MCP_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface AppProject {
  /** Null when the project has no repository binding. */
  repository: RepositoryBinding | null;
  packagePath: string | null;
}

/** Null = not an app-content project of this org (flag, plan or ownership). */
async function resolveAppProject(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
): Promise<AppProject | null> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!orgFlagEnabled(settings?.flags, "app_content_delivery")) return null;
  if (!(await orgHasFeature(ctx, organizationId, "cms"))) return null;

  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organizationId) {
    return null;
  }
  const metadata = (virtualMcp.metadata as Record<string, unknown>) ?? null;
  const repository = parseRepositoryBinding(
    metadata,
    virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
  );
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  const packagePath = runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
  return { repository, packagePath };
}

/** Head (and gates) re-resolved at most this often per project per pod. */
const REVALIDATE_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
// ponytail: counts decofile chars, not gzip copies; fine while few orgs opt in.
const MAX_CACHE_CHARS = 64 * 1024 * 1024;

const BASE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
} as const;
const CACHE_CONTROL =
  "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400";

/** `body: null` = a gate failed at `sha` (or before GitHub was reached). */
export interface PublishedLoad {
  sha: string | null;
  body: string | null;
  /** Repository + package the body was read from; a binding change must not
   *  reuse an entry of the previous one. */
  source?: string;
  /** False for ids that are not a project of the org — never cached, so junk
   *  ids cannot evict real entries. */
  cache: boolean;
}

interface CacheEntry extends PublishedLoad {
  checkedAt: number;
  gzip?: Promise<Uint8Array<ArrayBuffer>>;
}

export type PublishedLoader = (
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
  previous: PublishedLoad | undefined,
) => Promise<PublishedLoad>;

const NOT_A_PROJECT: PublishedLoad = { sha: null, body: null, cache: false };

const loadPublishedDecofile: PublishedLoader = async (
  ctx,
  organizationId,
  virtualMcpId,
  previous,
) => {
  const project = await resolveAppProject(ctx, organizationId, virtualMcpId);
  if (!project) return NOT_A_PROJECT;
  const gated: PublishedLoad = { sha: null, body: null, cache: true };
  const { repository, packagePath } = project;
  if (!repository) return gated;
  const source = JSON.stringify([
    repository.url,
    repository.owner,
    repository.name,
    repository.repositoryId ?? null,
    packagePath,
  ]);

  try {
    const client = await contentClientForProjectRepo(
      ctx,
      organizationId,
      repository,
    );
    const sha = await requireBranchHead(
      client,
      await client.getDefaultBranch(),
    );
    // Same commit, same answer: manifest and blocks are immutable per sha.
    if (previous?.sha === sha && previous.source === source) return previous;
    const manifest = await readAppManifest(client, sha, packagePath);
    if (manifest?.publishedContent !== true) return { ...gated, sha, source };
    const snapshot = await readDecofileAtSha(client, sha, packagePath);
    return { sha, body: snapshot.decofile, source, cache: true };
  } catch (err) {
    // A missing repo/credential is a gate, not an outage.
    if (repoErrorStatus(err) === 404) return gated;
    throw err;
  }
};

/** Drops every secret block — top-level or nested, in objects and arrays.
 *  Encrypted or not, secret material never leaves on an app surface. */
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => !isSecretBlock(v)).map(stripSecrets);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => !isSecretBlock(v))
      .map(([k, v]) => [k, stripSecrets(v)]),
  );
}

function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).bytes();
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t.replace(/^W\//, "") === etag;
  });
}

function notFound(c: Context) {
  return c.json({ error: "Not found" }, 404, {
    ...BASE_HEADERS,
    "Cache-Control": "no-store",
  });
}

export function createAppContentRoutes(
  deps: { load?: PublishedLoader; now?: () => number } = {},
) {
  const load = deps.load ?? loadPublishedDecofile;
  const now = deps.now ?? Date.now;
  const limiter = createWindowLimiter({ max: 120, windowMs: 60_000 });
  const flight = createSingleFlight<CacheEntry>();
  const cache = new Map<string, CacheEntry>();
  let cachedChars = 0;

  const forget = (key: string) => {
    cachedChars -= cache.get(key)?.body?.length ?? 0;
    cache.delete(key);
  };
  const remember = (key: string, entry: CacheEntry) => {
    cache.set(key, entry);
    cachedChars += entry.body?.length ?? 0;
    while (cache.size > MAX_CACHE_ENTRIES || cachedChars > MAX_CACHE_CHARS) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      forget(oldest.value);
    }
  };

  const app = new Hono<Env>();

  app.get("/:virtualMcpId", async (c) => {
    const organization = c.var.studioContext.organization;
    const virtualMcpId = c.req.param("virtualMcpId");
    if (!organization || !VIRTUAL_MCP_ID_RE.test(virtualMcpId)) {
      return notFound(c);
    }
    const key = `${organization.id}/${virtualMcpId}`;
    let entry = cache.get(key);
    if (!entry || now() - entry.checkedAt >= REVALIDATE_MS) {
      // Only the path that may reach GitHub is limited: cache hits are free,
      // and carriers put many phones behind one CGNAT address.
      if (!limiter.hit(clientIp(c), now())) {
        return c.json({ error: "Too many requests" }, 429, {
          ...BASE_HEADERS,
          "Cache-Control": "no-store",
          "Retry-After": "60",
        });
      }
      const previous = entry;
      try {
        entry = await flight.run(key, async () => {
          const loaded = await load(
            c.var.studioContext,
            organization.id,
            virtualMcpId,
            previous,
          );
          // The loader hands `previous` back when the head is unchanged, which
          // keeps its gzip copy.
          const next: CacheEntry =
            loaded === previous
              ? previous
              : {
                  ...loaded,
                  body:
                    loaded.body &&
                    JSON.stringify(stripSecrets(JSON.parse(loaded.body))),
                  checkedAt: 0,
                };
          next.checkedAt = now();
          forget(key);
          if (loaded.cache) remember(key, next);
          return next;
        });
      } catch (err) {
        if (!previous) {
          console.error("[app-content] published read failed", {
            organizationId: organization.id,
            virtualMcpId,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json({ error: "Upstream unavailable" }, 502, {
            ...BASE_HEADERS,
            "Cache-Control": "no-store",
          });
        }
        // stale-if-error; retry upstream after the next window, not per request.
        previous.checkedAt = now();
        entry = previous;
      }
    }

    if (!entry.body || !entry.sha) return notFound(c);

    // One tag per encoding (a shared cache must not swap the bodies); either
    // validates, since both carry the same content.
    const identity = `"${entry.sha}"`;
    const gzipped = `"${entry.sha}-gz"`;
    const wantsGzip = /\bgzip\b/i.test(c.req.header("accept-encoding") ?? "");
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      ETag: wantsGzip ? gzipped : identity,
      "Cache-Control": CACHE_CONTROL,
      Vary: "Accept-Encoding",
    };
    const inm = c.req.header("if-none-match");
    if (etagMatches(inm, identity) || etagMatches(inm, gzipped)) {
      return c.body(null, 304, headers);
    }
    headers["Content-Type"] = "application/json; charset=utf-8";
    if (wantsGzip) {
      const target = entry;
      target.gzip ??= gzip(entry.body).catch((err: unknown) => {
        target.gzip = undefined; // the next request retries
        throw err;
      });
      return c.body(await target.gzip, 200, {
        ...headers,
        "Content-Encoding": "gzip",
      });
    }
    return c.body(entry.body, 200, headers);
  });

  return app;
}
