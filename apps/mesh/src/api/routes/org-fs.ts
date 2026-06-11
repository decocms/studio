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

import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ForbiddenError, UnauthorizedError } from "@/core/access-control";
import type { StudioContext } from "@/core/studio-context";
import type { OrgFs } from "@/file-storage/org-fs";
import {
  OrgFsNotFoundError,
  OrgFsQuotaError,
  OrgFsValidationError,
} from "@/file-storage/org-fs";
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

export const createOrgFsRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

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
      return c.body(Buffer.from(bytes), 200, {
        "Content-Type": detectContentType(path),
        "Cache-Control": "private, max-age=0",
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  // Change feed since a cursor ("0" = from the beginning).
  app.get("/:volume/changes", async (c) => {
    const volume = c.req.param("volume");
    const r = await resolve(c, volume, "ORG_FS_READ");
    if (!r.ok) return r.res;
    const since = c.req.query("since") ?? "0";
    const limit = Math.min(
      Math.max(Number(c.req.query("limit")) || DEFAULT_CHANGES_LIMIT, 1),
      MAX_CHANGES_LIMIT,
    );
    try {
      return c.json(await r.fs.changes(volume, since, limit));
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
        return c.json({ ok: true });
      } catch (err) {
        return fsErrorResponse(c, err);
      }
    },
  );

  return app;
};
