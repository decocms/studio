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

import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { NatsConnection } from "@nats-io/nats-core";
import { ForbiddenError, UnauthorizedError } from "@/core/access-control";
import type { StudioContext } from "@/core/studio-context";
import type { OrgFs } from "@/file-storage/org-fs";
import {
  OrgFsNotFoundError,
  OrgFsQuotaError,
  OrgFsValidationError,
} from "@/file-storage/org-fs";
import {
  notifyOrgFsChange,
  orgFsChangeSubject,
} from "@/file-storage/org-fs-notify";
import { isValidVolume } from "@/file-storage/org-fs-path";
import {
  buildPublicOrgFs,
  getPublicSets,
  isPublicVolume,
} from "@/file-storage/public-sets";
import { detectContentType } from "@/object-storage/key-utils";

type Variables = { meshContext: StudioContext };
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
 * SSE keepalive cadence for `/changes?stream=1`. A comment frame every interval
 * resets the gateway/proxy idle timer, so the stream stays open indefinitely
 * (unlike the long-poll, which MUST return before the ~30s cap and reconnect).
 */
const CHANGES_STREAM_KEEPALIVE_MS = 15_000;
/**
 * Spread window for the post-nudge re-query. One write fans out to every mount
 * watching that (org, volume); jittering keeps a herd from hitting the change
 * feed in the same tick. Small enough to be invisible to file freshness.
 */
const CHANGES_NUDGE_JITTER_MS = 250;

type Resolved =
  | { ok: true; ctx: StudioContext; fs: OrgFs }
  | { ok: false; res: Response };

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
  const subject = nc ? orgFsChangeSubject(q.orgId, q.volume) : null;
  if (!nc || !subject) return query();

  const sub = nc.subscribe(subject, { max: 1 });
  const reqSignal = c.req.raw.signal;
  const abortListener = () => {
    try {
      sub.unsubscribe();
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
      (async () => {
        for await (const _msg of sub) return true;
        return false;
      })(),
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
      sub.unsubscribe();
    } catch {
      // ignore double-unsubscribe
    }
  }
}

/**
 * Server-push variant of the change feed: an SSE stream held open indefinitely.
 * One `changes` event per change-feed page, NDJSON-style cursor paging
 * preserved so the consumer primes exactly like the long-poll path. Subscribes
 * to the volume's NATS notify BEFORE the first drain (a write landing mid-
 * catch-up is buffered for the subscription, never missed), then re-drains on
 * every nudge. A keepalive comment defeats the gateway idle timeout, so steady
 * state is zero reconnects — push latency is the NATS publish.
 *
 * Caller guarantees `nc`/`subject` are non-null (no NATS → no push to give, so
 * the route falls back to the plain JSON page and the daemon uses its poll loop).
 */
function streamChanges(
  c: Ctx,
  fs: OrgFs,
  nc: NatsConnection,
  subject: string,
  q: { volume: string; since: string; limit: number },
): Response {
  // Defeat proxy buffering so frames flush as written (mirrors vm-events).
  c.header("X-Accel-Buffering", "no");
  c.header("Content-Encoding", "identity");
  return streamSSE(c, async (stream) => {
    let since = q.since;
    const sub = nc.subscribe(subject);
    const keepalive = setInterval(() => {
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        clearInterval(keepalive);
      });
    }, CHANGES_STREAM_KEEPALIVE_MS);
    stream.onAbort(() => {
      clearInterval(keepalive);
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
    });

    // Drain from `since` to the feed head, emitting one event per page and
    // advancing the cursor. `for await` over the subscription processes one
    // nudge at a time, so drains never interleave or double-advance `since`.
    const drain = async () => {
      for (;;) {
        const page = await fs.changes(q.volume, since, q.limit);
        await stream.writeSSE({ event: "changes", data: JSON.stringify(page) });
        since = page.cursor;
        if (!page.hasMore) return;
      }
    };

    try {
      await drain(); // catch-up: lets the consumer prime to the head
      for await (const _msg of sub) await drain();
    } finally {
      clearInterval(keepalive);
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
    }
  });
}

export interface OrgFsRoutesDeps {
  /**
   * Shared NATS connection (null until connected / when unconfigured). Powers
   * the `/changes?wait=1` long-poll, the `/changes?stream=1` SSE feed, and the
   * post-write wake-up nudge. Without it, `/changes` stays a plain
   * immediate-return feed.
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
    const ctx = c.get("meshContext");
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
    const ctx = c.get("meshContext");
    if (!ctx.auth?.user?.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ sets: getPublicSets().map((s) => s.set) });
  });

  // Most recently written files across every volume, newest first — the
  // Library page's "Recently added"/"All files" feed. Volume-less by design,
  // so it lives above the `/:volume/*` routes.
  app.get("/recent", async (c) => {
    const ctx = c.get("meshContext");
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
      return c.json({ entries: await ctx.orgFs.recent(limit) });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // --- Reads ---------------------------------------------------------------

  // List a directory's immediate children (path "" = volume root). Dirs
  // following the Claude Code skill format (containing SKILL.md) are marked
  // `hasSkill` — one batch probe — so the Library renders them first-class.
  app.get("/:volume/list", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    try {
      const entries = await r.fs.listDir(volume, c.req.query("path") ?? "");
      const dirs = entries.filter((e) => e.kind === "dir");
      const skillMds = dirs.length
        ? await r.fs.filesExist(
            volume,
            dirs.map((d) => `${d.path}/SKILL.md`),
          )
        : new Set<string>();
      return c.json({
        entries: entries.map((e) =>
          e.kind === "dir" && skillMds.has(`${e.path}/SKILL.md`)
            ? { ...e, hasSkill: true }
            : e,
        ),
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
      return c.json({ entry });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Read a file: `?presign=1` returns a presigned URL (the mount's byte path);
  // otherwise the bytes are streamed through mesh (convenient for the UI/dev).
  app.get("/:volume/read", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    const path = c.req.query("path") ?? "";
    try {
      if (c.req.query("presign")) {
        return c.json({ url: await r.fs.presignRead(volume, path) });
      }
      const bytes = await r.fs.read(volume, path);
      const contentType = detectContentType(path);
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=0",
      };
      // Member-authored HTML (deck previews, generated pages) renders in
      // sandboxed iframes AND can be opened top-level ("open in new tab",
      // PDF export). CSP-sandbox the response so the top-level document
      // also runs with an opaque origin — its scripts can't make
      // credentialed same-origin calls. allow-modals keeps window.print()
      // working for the deck PDF-export path.
      if (contentType.startsWith("text/html")) {
        headers["Content-Security-Policy"] =
          "sandbox allow-scripts allow-modals";
      }
      return c.body(Buffer.from(bytes), 200, headers);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Change feed since a cursor ("0" = from the beginning).
  //
  // `?stream=1` (preferred): an SSE stream held open indefinitely, pushing a
  // `changes` event per page on every write (NATS notify) with a keepalive to
  // beat the idle timeout — zero reconnects while idle. Requires NATS; without
  // it, falls through to a plain JSON page so the consumer can detect the
  // missing stream and use its poll loop.
  //
  // `?wait=1` long-polls: if nothing has changed since the cursor, the request
  // is held open (subscribed to the volume's NATS notify) until a write nudges
  // it or the hold time expires, then re-queried. The legacy push path, kept
  // for daemons that predate `stream=1`. Without NATS it degrades to an
  // immediate return (the daemon's own poll-timeout floor backs off so it
  // never busy-loops).
  app.get("/:volume/changes", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    const since = c.req.query("since") ?? "0";
    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_CHANGES_LIMIT, 1),
      MAX_CHANGES_LIMIT,
    );
    const stream =
      c.req.query("stream") === "1" || c.req.query("stream") === "true";
    const wait = c.req.query("wait") === "1" || c.req.query("wait") === "true";
    try {
      if (stream) {
        const nc = getConnection();
        const subject = nc
          ? orgFsChangeSubject(r.ctx.organization!.id, volume)
          : null;
        if (nc && subject) {
          // The stream loops `fs.changes` internally; reject a bad cursor up
          // front (it can't return a 400 once the SSE body has started).
          if (!/^\d+$/.test(since)) {
            return c.json({ error: `Invalid cursor: ${since}` }, 400);
          }
          return streamChanges(c, r.fs, nc, subject, { volume, since, limit });
        }
        // No NATS → fall through to a plain JSON page (not event-stream); the
        // daemon detects the content-type mismatch and uses its poll loop.
      }
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

  return app;
};
