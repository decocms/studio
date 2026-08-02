/**
 * Organization Filesystem Routes
 *
 * The cluster-side HTTP contract over the org filesystem (the primitive
 * object-storage keyspace, projected as path/tree volumes via `OrgFs`). The
 * sandbox mount/sync engine and the Drive-like UI both consume this surface;
 * bytes still move via object storage (presigned URLs for the mount).
 *
 * Mounted at `/api/:org/fs` (see org-scoped.ts). `resolveOrgFromPath` has
 * already resolved + membership-checked the org and rebound `ctx.orgFs` to it.
 *
 * Path is passed as the `path` query param (URL-decoded once by Hono, then
 * normalized traversal-safe by OrgFs) rather than a wildcard, so encoding of
 * slashes/special chars in nested paths is unambiguous. Volume is the route
 * param.
 *
 * Status codes: handlers return EXPLICIT responses (`c.json(..., status)`) and
 * never throw to reach the right code. The app's global `onError`
 * (app.ts) maps every *thrown* error — including `HTTPException` — to 500, so
 * throwing would collapse 400/401/403/404/413 into 500. Returning responses
 * sidesteps that entirely.
 *
 * ACL (decision A): every org member may read+write every volume. Reads gate on
 * `ORG_FS_READ`, writes on `ORG_FS_WRITE` (both basic-usage today); a future
 * per-volume ACL removes them from basic-usage and gates by role/permission
 * with no route changes. See `.context/org-filesystem-proposal.md`.
 */

import { exponentialBackoffWithJitter, sleep } from "@decocms/shared/std";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import type { NatsConnection } from "@nats-io/nats-core";
import { ForbiddenError, UnauthorizedError } from "@/core/access-control";
import type { StudioContext } from "@/core/studio-context";
import type { OrgFs, ReadAccess } from "@/file-storage/org-fs";
import {
  OrgFsNotFoundError,
  OrgFsQuotaError,
  OrgFsValidationError,
} from "@/file-storage/org-fs";
import {
  signUnlockToken,
  unlockCookieName,
  verifySharePassword,
  verifyUnlockToken,
} from "@/file-storage/share-password";
import type { ShareMode } from "@/storage/org-fs";
import {
  notifyOrgFsChange,
  orgFsChangeSubjects,
} from "@/file-storage/org-fs-notify";
import { isValidVolume } from "@/file-storage/org-fs-path";
import {
  buildPublicOrgFs,
  getPublicSets,
  isPublicVolume,
  publicVolumeForSet,
} from "@/file-storage/public-sets";
import { buildSkillCatalog } from "@/file-storage/skill-catalog";
import { detectContentType } from "@/object-storage/key-utils";

type Variables = { studioContext: StudioContext };
type Ctx = Context<{ Variables: Variables }>;

/** Hard ceiling on a single uploaded body (matches the per-file quota). */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
/** Ceiling on the tiny JSON control bodies (e.g. /move's `{from,to}`). */
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_CHANGES_LIMIT = 1000;
const DEFAULT_CHANGES_LIMIT = 500;
const MAX_RECENT_LIMIT = 200;
const DEFAULT_RECENT_LIMIT = 50;
/** Long-poll hold time, just under the usual 30s gateway/proxy timeout. */
const CHANGES_LONG_POLL_MS = 28_000;
/**
 * Spread window for the post-nudge re-query. One write fans out to every mount
 * watching that (org, volume); jittering keeps a herd from hitting the change
 * feed in the same tick. Small enough to be invisible to file freshness.
 */
const CHANGES_NUDGE_JITTER_MS = 250;

type Resolved =
  | { ok: true; ctx: StudioContext; fs: OrgFs }
  | { ok: false; res: Response };

/**
 * Stream file bytes with the right content-type and, for member-authored HTML
 * (deck previews, generated pages), a sandbox CSP so the top-level document
 * runs with an opaque origin — its scripts can't make credentialed same-origin
 * calls. allow-modals keeps window.print() working for the deck PDF-export
 * path. Public files revalidate (no shared caching past an unpublish); private
 * files stay uncacheable.
 */
function byteResponse(
  c: Ctx,
  bytes: Uint8Array,
  path: string,
  isPublic: boolean,
): Response {
  const contentType = detectContentType(path);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": isPublic
      ? "public, max-age=0, must-revalidate"
      : "private, max-age=0",
  };
  if (contentType.startsWith("text/html")) {
    // TEMP(demo 2026-07-08, REVERT): allow-same-origin gives previews a real
    // origin so nested frame-ancestors checks pass — but re-enables
    // credentialed same-origin API calls from member HTML.
    headers["Content-Security-Policy"] =
      "sandbox allow-scripts allow-modals allow-same-origin allow-downloads";
  }
  return c.body(Buffer.from(bytes), 200, headers);
}

// --- Password share gate -------------------------------------------------

/** Unlock cookie lifetime. */
const UNLOCK_TTL_SEC = 60 * 60 * 12;
/**
 * Per (IP, share) attempt cap — the normal-case limiter. Best-effort: the
 * client IP can be spoofed via X-Forwarded-For when not behind a trusted proxy,
 * which is why the per-share cap is the real backstop.
 */
const UNLOCK_IP_MAX = 10;
/**
 * Per-share attempt cap across ALL IPs — bounds brute-force even when the
 * per-IP limit is evaded by rotating X-Forwarded-For. Generous enough to
 * tolerate a few users + typos without locking out a legitimate share.
 */
const UNLOCK_SHARE_MAX = 50;
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;

/**
 * In-memory unlock rate limiter — per-instance, so it blunts brute-force on a
 * single share but doesn't coordinate across replicas. Lazily swept so the map
 * stays bounded. Good enough for a v1 gate; revisit if it needs to be global.
 */
const unlockAttempts = new Map<string, { count: number; resetAt: number }>();
function overLimit(key: string, max: number): boolean {
  const e = unlockAttempts.get(key);
  return !!e && Date.now() <= e.resetAt && e.count >= max;
}
function unlockAllowed(ipKey: string, shareKey: string): boolean {
  return (
    !overLimit(ipKey, UNLOCK_IP_MAX) && !overLimit(shareKey, UNLOCK_SHARE_MAX)
  );
}
function bumpAttempt(key: string, now: number): void {
  const e = unlockAttempts.get(key);
  if (!e || now > e.resetAt) {
    unlockAttempts.set(key, { count: 1, resetAt: now + UNLOCK_WINDOW_MS });
  } else {
    e.count++;
  }
}
function recordUnlockFail(ipKey: string, shareKey: string): void {
  const now = Date.now();
  if (unlockAttempts.size > 5000) {
    for (const [k, v] of unlockAttempts)
      if (now > v.resetAt) unlockAttempts.delete(k);
  }
  bumpAttempt(ipKey, now);
  bumpAttempt(shareKey, now);
}

function clientIp(c: Ctx): string {
  // cf-connecting-ip is set by Cloudflare and not client-spoofable behind it;
  // x-real-ip by many reverse proxies. The leftmost x-forwarded-for is
  // client-supplied (spoofable) — last resort only.
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-real-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function requestIsSecure(c: Ctx): boolean {
  if (c.req.header("x-forwarded-proto") === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** A valid, non-stale unlock cookie for a password-gated read? */
function isUnlocked(
  c: Ctx,
  org: string,
  volume: string,
  access: Extract<ReadAccess, { access: "password" }>,
): boolean {
  const token = getCookie(c, unlockCookieName(org, volume, access.govPath));
  if (!token) return false;
  const res = verifyUnlockToken(token, {
    org,
    volume,
    secret: access.secret,
    nowSec: Math.floor(Date.now() / 1000),
  });
  return res?.govPath === access.govPath;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The interstitial password page served before a gated file (never the
 *  sandbox CSP — the form must POST). */
function passwordFormResponse(
  c: Ctx,
  opts: { orgSlug: string; volume: string; path: string; error?: string },
  status: 401 | 429 = 401,
): Response {
  const action = `/api/${encodeURIComponent(opts.orgSlug)}/fs/${encodeURIComponent(
    opts.volume,
  )}/unlock?path=${encodeURIComponent(opts.path)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Password required</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#f6f6f7;color:#18181b}
@media(prefers-color-scheme:dark){body{background:#0b0b0c;color:#fafafa}}
form{width:min(92vw,360px);padding:28px;border-radius:14px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1),0 8px 30px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:14px}
@media(prefers-color-scheme:dark){form{background:#161618}}
h1{margin:0;font-size:16px}
p{margin:0;font-size:13px;color:#71717a}
input{padding:10px 12px;border-radius:9px;border:1px solid #d4d4d8;font-size:14px;background:transparent;color:inherit}
@media(prefers-color-scheme:dark){input{border-color:#3f3f46}}
button{padding:10px 12px;border-radius:9px;border:0;background:#18181b;color:#fff;font-size:14px;font-weight:500;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#fafafa;color:#18181b}}
.err{color:#dc2626;font-size:13px}
</style></head><body><form method="post" action="${escapeHtml(action)}">
<h1>🔒 Password required</h1>
<p>This file is shared with a password. Enter it to view.</p>
${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ""}
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
<button type="submit">Unlock</button>
</form></body></html>`;
  return c.body(html, status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

/** Translate an OrgFs error into an explicit JSON response (never thrown). */
function fsErrorResponse(c: Ctx, err: unknown): Response {
  if (err instanceof OrgFsQuotaError)
    return c.json({ error: err.message }, 413);
  if (err instanceof OrgFsNotFoundError)
    return c.json({ error: err.message }, 404);
  if (err instanceof OrgFsValidationError)
    return c.json({ error: err.message }, 400);
  // Unexpected — let the global handler log + 500 it.
  throw err;
}

/**
 * Long-poll the change feed: return immediately if there's already data,
 * otherwise hold until a NATS nudge for this volume or the hold timeout, then
 * re-query once. Subscribes BEFORE the first query so a write landing in
 * between can't be missed (NATS buffers it for the active subscription). Falls
 * back to a plain immediate query when NATS is unavailable.
 */
async function waitForChanges(
  c: Ctx,
  fs: OrgFs,
  nc: NatsConnection | null,
  q: { orgId: string; volume: string; since: string; limit: number },
): Promise<Awaited<ReturnType<OrgFs["changes"]>>> {
  const query = () => fs.changes(q.volume, q.since, q.limit);
  const subjects = nc ? orgFsChangeSubjects(q.orgId, q.volume) : [];
  if (!nc || subjects.length === 0) return query();

  const subscriptions = subjects.map((subject) =>
    nc.subscribe(subject, { max: 1 }),
  );
  const reqSignal = c.req.raw.signal;
  const abortListener = () => {
    try {
      for (const subscription of subscriptions) subscription.unsubscribe();
    } catch {
      // ignore
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await query();
    if (first.entries.length > 0) return first;
    if (reqSignal?.aborted) return first;
    if (reqSignal)
      reqSignal.addEventListener("abort", abortListener, {
        once: true,
      });

    // Wins as `true` on a nudge, `false` on the hold timeout (or when the
    // subscription is closed by an abort). `.unref()` so a parked timer never
    // keeps the process from exiting.
    const nudged = await Promise.race([
      ...subscriptions.map(async (subscription) => {
        for await (const _msg of subscription) return true;
        return false;
      }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CHANGES_LONG_POLL_MS);
        timer.unref?.();
      }),
    ]);

    if (!nudged) return first;

    await sleep(
      exponentialBackoffWithJitter(
        CHANGES_NUDGE_JITTER_MS,
        CHANGES_NUDGE_JITTER_MS,
        0,
        1,
        1,
      ),
      {
        signal: reqSignal ?? undefined,
      },
    ).catch(() => {});
    if (reqSignal?.aborted) return first;
    return query();
  } finally {
    if (timer) clearTimeout(timer);
    if (reqSignal && !reqSignal.aborted) {
      reqSignal.removeEventListener("abort", abortListener);
    }
    try {
      for (const subscription of subscriptions) subscription.unsubscribe();
    } catch {
      // ignore double-unsubscribe
    }
  }
}

export interface OrgFsRoutesDeps {
  /**
   * Shared NATS connection (null until connected / when unconfigured). Powers
   * the `/changes?wait=1` long-poll and the post-write wake-up nudge. Without
   * it, `/changes` stays a plain immediate-return feed.
   */
  getConnection?: () => NatsConnection | null;
}

export const createOrgFsRoutes = (deps: OrgFsRoutesDeps = {}) => {
  const app = new Hono<{ Variables: Variables }>();
  const getConnection = deps.getConnection ?? (() => null);

  /** access.check with the thrown auth errors mapped to explicit responses. */
  const checkPermission = async (
    c: Ctx,
    ctx: StudioContext,
    permission: "ORG_FS_READ" | "ORG_FS_WRITE",
  ): Promise<Response | null> => {
    try {
      await ctx.access.check(permission);
      return null;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return c.json({ error: err.message }, 401);
      }
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }
  };

  /**
   * Resolve the authenticated, org-scoped OrgFs for this request, gating on the
   * given permission. Returns an explicit error response (401/400/403/503) on
   * failure rather than throwing.
   */
  const resolve = async (
    c: Ctx,
    volume: string,
    permission: "ORG_FS_READ" | "ORG_FS_WRITE",
  ): Promise<Resolved> => {
    const ctx = c.get("studioContext");
    if (!ctx.auth?.user?.id) {
      return { ok: false, res: c.json({ error: "Unauthorized" }, 401) };
    }
    if (!ctx.organization?.id) {
      return {
        ok: false,
        res: c.json({ error: "Organization required" }, 400),
      };
    }
    if (!isValidVolume(volume)) {
      return { ok: false, res: c.json({ error: "Invalid volume name" }, 400) };
    }
    // `public-*` volumes are the shared skill sets: readable by any member
    // of any org, never writable over HTTP (the syncer writes server-side).
    if (isPublicVolume(volume) && permission !== "ORG_FS_READ") {
      return {
        ok: false,
        res: c.json({ error: "Public volumes are read-only" }, 403),
      };
    }
    const denied = await checkPermission(c, ctx, permission);
    if (denied) return { ok: false, res: denied };
    if (isPublicVolume(volume)) {
      return { ok: true, ctx, fs: buildPublicOrgFs(ctx) };
    }
    if (!ctx.orgFs) {
      return {
        ok: false,
        res: c.json({ error: "Object storage not configured" }, 503),
      };
    }
    return { ok: true, ctx, fs: ctx.orgFs };
  };

  // The deployment's configured public skill sets (names only — the UI's
  // root listing). Member-gated like any read.
  app.get("/public-sets", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth?.user?.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ sets: getPublicSets().map((s) => s.set) });
  });

  // Most recently written files across every volume, newest first — the
  // Library page's "Recently added" feed. Volume-less by design, so it
  // lives above the `/:volume/*` routes.
  app.get("/recent", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth?.user?.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!ctx.organization?.id) {
      return c.json({ error: "Organization required" }, 400);
    }
    const denied = await checkPermission(c, ctx, "ORG_FS_READ");
    if (denied) return denied;
    if (!ctx.orgFs) {
      return c.json({ error: "Object storage not configured" }, 503);
    }
    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_RECENT_LIMIT, 1),
      MAX_RECENT_LIMIT,
    );
    try {
      return c.json({
        entries: await ctx.orgFs.recentWithEffectivePublic(limit),
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Path search (case-insensitive substring), newest first — the Library's
  // search box. Cross-volume by default; `volume` (+ optional `prefix`) narrows
  // it to one volume and directory subtree, which is what the Library does while
  // you're browsing inside a folder. Volume-less by design (the volume is a
  // query param, not a path segment), so it lives above the `/:volume/*` routes.
  app.get("/search", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth?.user?.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!ctx.organization?.id) {
      return c.json({ error: "Organization required" }, 400);
    }
    const denied = await checkPermission(c, ctx, "ORG_FS_READ");
    if (denied) return denied;
    if (!ctx.orgFs) {
      return c.json({ error: "Object storage not configured" }, 503);
    }
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ entries: [] });
    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_RECENT_LIMIT, 1),
      MAX_RECENT_LIMIT,
    );
    const scopeVolume = c.req.query("volume") || null;
    if (scopeVolume !== null && !isValidVolume(scopeVolume)) {
      return c.json({ error: "Invalid volume name" }, 400);
    }
    const prefix = c.req.query("prefix") || undefined;
    try {
      // Two manifests: the org's own volumes plus the deployment's shared
      // public sets (pseudo-org, gated to the configured set volumes like
      // the browse routes). `seq` is one global sequence, so interleaving
      // by seq desc preserves write order across both.
      const publicVolumes = getPublicSets().map((s) =>
        publicVolumeForSet(s.set),
      );
      // A `public-<set>` volume lives in the shared pseudo-org, every other
      // volume in the org's own — so a scoped search hits exactly one manifest,
      // and scoping to an unconfigured `public-*` volume hits neither.
      const scopedPublic = scopeVolume !== null && isPublicVolume(scopeVolume);
      const ownVolumes = scopeVolume === null ? undefined : [scopeVolume];
      const pubVolumes =
        scopeVolume === null
          ? publicVolumes
          : scopedPublic && publicVolumes.includes(scopeVolume)
            ? [scopeVolume]
            : [];
      const [own, pub] = await Promise.all([
        scopedPublic
          ? []
          : ctx.orgFs.searchWithEffectivePublic(q, limit, ownVolumes, prefix),
        pubVolumes.length > 0
          ? buildPublicOrgFs(ctx).searchWithEffectivePublic(
              q,
              limit,
              pubVolumes,
              prefix,
            )
          : [],
      ]);
      const entries = [...own, ...pub]
        .sort((a, b) => Number(BigInt(b.seq) - BigInt(a.seq)))
        .slice(0, limit);
      return c.json({ entries });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Attachable skills — the SAME catalog the runtime surfaces in
  // <available-skills> (buildSkillCatalog: home + home/skills + public sets), so
  // the agent link picker and the run can never drift on what "a skill" is.
  // Volume-less; lives above the `/:volume/*` routes. Member-gated read.
  app.get("/skills", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth?.user?.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!ctx.organization?.id) {
      return c.json({ error: "Organization required" }, 400);
    }
    const denied = await checkPermission(c, ctx, "ORG_FS_READ");
    if (denied) return denied;
    try {
      return c.json({
        skills: await buildSkillCatalog(ctx, ctx.organization.id),
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // --- Reads ---------------------------------------------------------------

  // List a directory's immediate children (path "" = volume root). Dirs
  // following a known folder convention are marked so the Library renders
  // them first-class — `hasSkill` (Claude Code skills, contain SKILL.md) and
  // `hasBrand` (brand folders, contain tokens.css or brand.md). One batch
  // probe covers every candidate marker file.
  app.get("/:volume/list", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    const path = c.req.query("path") ?? "";
    try {
      const entries = await r.fs.listDir(volume, path);
      const dirs = entries.filter((e) => e.kind === "dir");
      const exists = dirs.length
        ? await r.fs.filesExist(
            volume,
            dirs.flatMap((d) => [
              `${d.path}/SKILL.md`,
              `${d.path}/tokens.css`,
              `${d.path}/brand.md`,
            ]),
          )
        : new Set<string>();
      // Children of a published folder inherit public — one query for the
      // whole listing, OR'd with each entry's own flag.
      const inherit = await r.fs.childrenInheritPublic(volume, path);
      return c.json({
        entries: entries.map((e) => {
          const effectivePublic = e.readPublic || inherit;
          if (e.kind !== "dir") return { ...e, effectivePublic };
          const hasSkill = exists.has(`${e.path}/SKILL.md`);
          const hasBrand =
            exists.has(`${e.path}/tokens.css`) ||
            exists.has(`${e.path}/brand.md`);
          return {
            ...e,
            effectivePublic,
            ...(hasSkill && { hasSkill }),
            ...(hasBrand && { hasBrand }),
          };
        }),
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Metadata for a single entry (404 if absent).
  app.get("/:volume/stat", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    try {
      const entry = await r.fs.stat(volume, c.req.query("path") ?? "");
      if (!entry) return c.json({ error: "Not found" }, 404);
      const effectivePublic =
        entry.readPublic || (await r.fs.inheritsPublic(volume, entry.path));
      return c.json({ entry: { ...entry, effectivePublic } });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Read a file: `?presign=1` returns a presigned URL (the mount's byte path);
  // otherwise the bytes are streamed through studio (convenient for the UI/dev).
  //
  // Share fast-path: resolveOrgFromPath binds ctx.orgFs and lets anonymous /
  // non-member callers reach this route (its public-share carve-out). A
  // `public` file streams to anyone; a `password` file streams only with a
  // valid unlock cookie, else returns the interstitial form. Everything else
  // (private, or password-without-cookie for a member) falls through to the
  // member-gated read — members never see the password prompt. `?presign` stays
  // member-only; `public-*` skill volumes are a separate, member-gated path.
  app.get("/:volume/read", async (c) => {
    const volume = c.req.param("volume");
    const path = c.req.query("path") ?? "";
    const ctx = c.get("studioContext");

    let access: ReadAccess = { access: "private" };
    if (
      !c.req.query("presign") &&
      ctx.organization?.id &&
      ctx.orgFs &&
      isValidVolume(volume) &&
      !isPublicVolume(volume)
    ) {
      // A probe failure falls through to the member-gated read, never 500s.
      access = await ctx.orgFs
        .resolveReadAccess(volume, path)
        .catch(() => ({ access: "private" as const }));
      const serveOpen =
        access.access === "public" ||
        (access.access === "password" &&
          isUnlocked(c, ctx.organization.id, volume, access));
      if (serveOpen) {
        try {
          // Public files may be shared-cached; password content must not be.
          return byteResponse(
            c,
            await ctx.orgFs.read(volume, path),
            path,
            access.access === "public",
          );
        } catch (err) {
          return fsErrorResponse(c, err);
        }
      }
    }

    // Member-gated. A non-member/anonymous hitting a password file gets the
    // unlock form; a member reading it bypasses the prompt entirely.
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) {
      if (access.access === "password") {
        return passwordFormResponse(c, {
          orgSlug: ctx.organization?.slug ?? "",
          volume,
          path,
        });
      }
      return r.res;
    }
    try {
      if (c.req.query("presign")) {
        return c.json({ url: await r.fs.presignRead(volume, path) });
      }
      return byteResponse(c, await r.fs.read(volume, path), path, false);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Change feed since a cursor ("0" = from the beginning).
  //
  // `?wait=1` long-polls: if nothing has changed since the cursor, the request
  // is held open (subscribed to the volume's NATS notify) until a write nudges
  // it or the hold time expires, then re-queried. This lets the mount
  // invalidator wake instantly on writes instead of polling on a timer. Without
  // a NATS connection it degrades to an immediate return (the daemon's own
  // poll-timeout floor backs off so it never busy-loops).
  app.get("/:volume/changes", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    const since = c.req.query("since") ?? "0";
    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_CHANGES_LIMIT, 1),
      MAX_CHANGES_LIMIT,
    );
    const wait = c.req.query("wait") === "1" || c.req.query("wait") === "true";
    try {
      if (!wait) {
        return c.json(await r.fs.changes(volume, since, limit));
      }
      return c.json(
        await waitForChanges(c, r.fs, getConnection(), {
          orgId: r.ctx.organization!.id,
          volume,
          since,
          limit,
        }),
      );
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Volume usage (file count + bytes) for quota display.
  app.get("/:volume/usage", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    try {
      return c.json(await r.fs.usage(volume));
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // --- Writes --------------------------------------------------------------

  // Write a file (raw body). Parent dirs are created as needed.
  app.put(
    "/:volume/file",
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES,
      onError: (c) =>
        c.json({ error: "File exceeds the per-file size limit" }, 413),
    }),
    async (c) => {
      const volume = c.req.param("volume");
      const r = await resolve(c, volume, "ORG_FS_WRITE");
      if (!r.ok) return r.res;
      const path = c.req.query("path") ?? "";
      const contentType = c.req.header("content-type");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      try {
        const entry = await r.fs.write(volume, path, bytes, {
          actor: r.ctx.auth!.user!.id,
          contentType:
            contentType && contentType !== "application/octet-stream"
              ? contentType
              : undefined,
        });
        notifyOrgFsChange(getConnection(), r.ctx.organization!.id, volume);
        return c.json({ entry });
      } catch (err) {
        return fsErrorResponse(c, err);
      }
    },
  );

  // Create a directory (and ancestors). Idempotent.
  app.post("/:volume/dir", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_WRITE");
    if (!r.ok) return r.res;
    try {
      await r.fs.mkdir(volume, c.req.query("path") ?? "", {
        actor: r.ctx.auth!.user!.id,
      });
      notifyOrgFsChange(getConnection(), r.ctx.organization!.id, volume);
      return c.json({ ok: true });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Delete a file, or a directory and everything under it.
  app.delete("/:volume/file", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_WRITE");
    if (!r.ok) return r.res;
    try {
      await r.fs.delete(volume, c.req.query("path") ?? "", {
        actor: r.ctx.auth!.user!.id,
      });
      notifyOrgFsChange(getConnection(), r.ctx.organization!.id, volume);
      return c.json({ ok: true });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Move/rename a file or directory. Body: { from, to }.
  app.post(
    "/:volume/move",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
      const volume = c.req.param("volume");
      const r = await resolve(c, volume, "ORG_FS_WRITE");
      if (!r.ok) return r.res;
      const body = (await c.req.json().catch(() => null)) as {
        from?: unknown;
        to?: unknown;
      } | null;
      if (
        !body ||
        typeof body.from !== "string" ||
        typeof body.to !== "string"
      ) {
        return c.json(
          { error: "Body must be { from: string, to: string }" },
          400,
        );
      }
      try {
        await r.fs.move(volume, body.from, body.to, {
          actor: r.ctx.auth!.user!.id,
        });
        notifyOrgFsChange(getConnection(), r.ctx.organization!.id, volume);
        return c.json({ ok: true });
      } catch (err) {
        return fsErrorResponse(c, err);
      }
    },
  );

  // Set an entry's share mode. Body: { mode: 'private'|'public'|'password',
  // password? } (back-compat: { public: boolean }). Works on a file (shares it)
  // or a dir (shares its whole subtree). Gated on ORG_FS_WRITE — you can share
  // what you can write — and rejected on read-only `public-*` volumes by
  // resolve(). Setting/changing the password rotates the node secret, so
  // outstanding unlock cookies stop working. No `seq` bump.
  app.post(
    "/:volume/public",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
      const volume = c.req.param("volume");
      const r = await resolve(c, volume, "ORG_FS_WRITE");
      if (!r.ok) return r.res;
      const path = c.req.query("path") ?? "";
      const body = (await c.req.json().catch(() => null)) as {
        mode?: unknown;
        public?: unknown;
        password?: unknown;
      } | null;
      const mode: ShareMode | null =
        body?.mode === "private" ||
        body?.mode === "public" ||
        body?.mode === "password"
          ? body.mode
          : typeof body?.public === "boolean"
            ? body.public
              ? "public"
              : "private"
            : null;
      if (!mode) {
        return c.json(
          {
            error:
              "Body must be { mode: 'private'|'public'|'password', password? }",
          },
          400,
        );
      }
      const password =
        typeof body?.password === "string" ? body.password : undefined;
      try {
        const entry = await r.fs.setShareMode(volume, path, mode, {
          actor: r.ctx.auth!.user!.id,
          password,
        });
        return c.json({ entry });
      } catch (err) {
        return fsErrorResponse(c, err);
      }
    },
  );

  // Unlock a password-gated share: verify the password, set the scoped unlock
  // cookie, redirect back to the file. No auth (the public-facing gate);
  // rate-limited per IP+path. resolveOrgFromPath's carve-out lets non-members
  // reach it. Returns the form (with an error) on a bad/rate-limited attempt.
  app.post(
    "/:volume/unlock",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
    async (c) => {
      const volume = c.req.param("volume");
      const path = c.req.query("path") ?? "";
      const ctx = c.get("studioContext");
      const orgId = ctx.organization?.id;
      const orgSlug = ctx.organization?.slug ?? "";
      if (
        !orgId ||
        !ctx.orgFs ||
        !isValidVolume(volume) ||
        isPublicVolume(volume)
      ) {
        return c.json({ error: "Not found" }, 404);
      }
      const access = await ctx.orgFs
        .resolveReadAccess(volume, path)
        .catch(() => ({ access: "private" as const }));
      if (access.access !== "password") {
        return c.json({ error: "Not password-protected" }, 404);
      }
      // Rate-limit on the GOVERNING node, not the requested path: a folder
      // password is one credential for the whole subtree, so all of its
      // sub-paths must share one attempt budget — otherwise an attacker
      // multiplies the lockout by guessing sibling paths under the same share.
      // Per-IP (normal case) + per-share (backstop vs X-Forwarded-For spoofing).
      const ipKey = `${clientIp(c)}|${orgId}|${volume}|${access.govPath}`;
      const shareKey = `share|${orgId}|${volume}|${access.govPath}`;
      if (!unlockAllowed(ipKey, shareKey)) {
        return passwordFormResponse(
          c,
          {
            orgSlug,
            volume,
            path,
            error: "Too many attempts — wait a few minutes.",
          },
          429,
        );
      }
      const formBody = await c.req
        .parseBody()
        .catch(() => ({}) as Record<string, unknown>);
      const password =
        typeof formBody.password === "string" ? formBody.password : "";
      if (
        !password ||
        !(await verifySharePassword(password, access.passwordHash))
      ) {
        recordUnlockFail(ipKey, shareKey);
        return passwordFormResponse(
          c,
          { orgSlug, volume, path, error: "Incorrect password." },
          401,
        );
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const token = signUnlockToken({
        o: orgId,
        v: volume,
        p: access.govPath,
        s: access.secret,
        e: nowSec + UNLOCK_TTL_SEC,
      });
      setCookie(c, unlockCookieName(orgId, volume, access.govPath), token, {
        httpOnly: true,
        secure: requestIsSecure(c),
        sameSite: "Lax",
        path: `/api/${encodeURIComponent(orgSlug)}/fs/${encodeURIComponent(volume)}/read`,
        maxAge: UNLOCK_TTL_SEC,
      });
      return c.redirect(
        `/api/${encodeURIComponent(orgSlug)}/fs/${encodeURIComponent(volume)}/read?path=${encodeURIComponent(path)}`,
        303,
      );
    },
  );

  return app;
};
