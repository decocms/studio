/**
 * Published decofile for mobile apps — anonymous, read-only, cacheable.
 *
 *   GET /api/:org/app-content/:virtualMcpId
 *
 * Always the default branch head: a draft branch is never served here (drafts
 * reach phones only through preview sessions). Every gate — org flag
 * `app_content_delivery`, `cms` plan, project in the org, repository binding,
 * `.deco/app.json` with `publishedContent: true` — fails to the same 404 so
 * the route cannot be used to enumerate projects.
 *
 * `resolveOrgFromPath` lets anonymous callers through with the org resolved;
 * this route self-enforces its gates.
 */

import { Hono, type Context } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { readAppManifest } from "@/app-content/manifest";
import { resolveAppProject, VIRTUAL_MCP_ID_RE } from "@/app-content/project";
import { readDecofileAtSha } from "@/decofile/read-decofile";
import { createSingleFlight } from "@/decofile/single-flight";
import {
  contentClientForProjectRepo,
  repoErrorStatus,
  requireBranchHead,
} from "@/git-providers";
import type { Env } from "../hono-env";
import { clientIp, createWindowLimiter } from "../utils/rate-limit";

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
    if (previous && previous.sha === sha) return previous;
    const manifest = await readAppManifest(client, sha, packagePath);
    if (manifest?.publishedContent !== true) return { ...gated, sha };
    const snapshot = await readDecofileAtSha(client, sha, packagePath);
    return { sha, body: snapshot.decofile, cache: true };
  } catch (err) {
    // A missing repo/credential is a gate, not an outage.
    if (repoErrorStatus(err) === 404) return gated;
    throw err;
  }
};

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
    if (!limiter.hit(clientIp(c), now())) {
      return c.json({ error: "Too many requests" }, 429, {
        ...BASE_HEADERS,
        "Cache-Control": "no-store",
        "Retry-After": "60",
      });
    }

    const key = `${organization.id}/${virtualMcpId}`;
    let entry = cache.get(key);
    if (!entry || now() - entry.checkedAt >= REVALIDATE_MS) {
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
            loaded === previous ? previous : { ...loaded, checkedAt: 0 };
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

    const etag = `"${entry.sha}"`;
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      ETag: etag,
      "Cache-Control": CACHE_CONTROL,
      Vary: "Accept-Encoding",
    };
    if (etagMatches(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, headers);
    }
    headers["Content-Type"] = "application/json; charset=utf-8";
    if (/\bgzip\b/i.test(c.req.header("accept-encoding") ?? "")) {
      entry.gzip ??= gzip(entry.body);
      return c.body(await entry.gzip, 200, {
        ...headers,
        "Content-Encoding": "gzip",
      });
    }
    return c.body(entry.body, 200, headers);
  });

  return app;
}
