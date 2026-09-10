/**
 * User Filesystem Routes
 *
 * The instance-level HTTP contract over a person's own filesystem (see
 * `file-storage/user-fs.ts` for why the scope exists). Mounted at
 * `/api/_users`, ahead of the `/api/:org` catch-all, because nothing here
 * belongs to a tenant: `user.image` is global to the person, so an org-scoped
 * URL would 403 for teammates in that user's *other* organizations.
 *
 * ACL: a volume is named by its owner's user id, and every write requires the
 * session user to be that owner. Reads serve published files to anyone —
 * that's the point, an avatar renders for logged-out visitors — and otherwise
 * fall back to owner-only.
 *
 * Status codes: handlers return EXPLICIT responses and never throw to reach
 * the right code, because the app's global `onError` maps every thrown error
 * to 500 (same constraint as the org-fs routes).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { StudioContext } from "@/core/studio-context";
import {
  OrgFsNotFoundError,
  OrgFsQuotaError,
  OrgFsValidationError,
} from "@/file-storage/org-fs";
import {
  buildUserFs,
  deleteUserAvatar,
  isValidUserVolume,
  listUserAvatars,
  MAX_AVATAR_BYTES,
  pruneAvatars,
  putUserAvatar,
  setCurrentAvatar,
  sniffAvatarType,
  userFsReadUrl,
} from "@/file-storage/user-fs";
import { fsByteResponse } from "../utils/fs-bytes";

type Variables = { studioContext: StudioContext };

function fsErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof OrgFsNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof OrgFsValidationError) {
    return c.json({ error: err.message }, 400);
  }
  if (err instanceof OrgFsQuotaError) {
    return c.json({ error: err.message }, 413);
  }
  console.error("[user-fs] request failed", err);
  return c.json({ error: "Internal error" }, 500);
}

/** The signed-in owner, or a response explaining why there isn't one. */
function requireOwner(
  c: Context,
): { ok: true; userId: string } | { ok: false; res: Response } {
  const ctx = c.get("studioContext") as StudioContext;
  const userId = ctx.auth?.user?.id;
  if (!userId)
    return { ok: false, res: c.json({ error: "Unauthorized" }, 401) };
  if (!isValidUserVolume(userId)) {
    return { ok: false, res: c.json({ error: "Unsupported user id" }, 400) };
  }
  return { ok: true, userId };
}

export const createUserFsRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  /**
   * Serve a file from a user's volume. Published files (today: everything
   * under `avatars/`) stream to anyone; anything else is owner-only and 404s
   * for everybody else rather than 403ing, so a private path's existence
   * isn't confirmed to a stranger.
   */
  app.get("/fs/:userId/read", async (c) => {
    const userId = c.req.param("userId");
    const path = c.req.query("path") ?? "";
    if (!isValidUserVolume(userId)) {
      return c.json({ error: "Invalid user id" }, 400);
    }

    const ctx = c.get("studioContext");
    const fs = buildUserFs(ctx);

    /** A probe failure falls back to owner-only, never 500s. */
    const access = await fs
      .resolveReadAccess(userId, path)
      .catch(() => ({ access: "private" as const }));

    const isPublic = access.access === "public";
    if (!isPublic && ctx.auth?.user?.id !== userId) {
      return c.json({ error: "Not found" }, 404);
    }

    try {
      return fsByteResponse(c, await fs.read(userId, path), path, isPublic);
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  /**
   * Replace the caller's avatar. Takes the raw bytes as the body (not
   * multipart) and answers with the URL to store in `user.image` — the client
   * still persists it through Better Auth, which stays the only writer of
   * that column.
   */
  app.post(
    "/avatar",
    bodyLimit({
      maxSize: MAX_AVATAR_BYTES,
      onError: (c) => c.json({ error: "Avatar exceeds the size limit" }, 413),
    }),
    async (c) => {
      const owner = requireOwner(c);
      if (!owner.ok) return owner.res;
      const { userId } = owner;
      const ctx = c.get("studioContext");

      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) {
        return c.json({ error: "Empty request body" }, 400);
      }

      const type = sniffAvatarType(bytes);
      if (!type) {
        return c.json(
          { error: "Avatar must be a PNG, JPEG, GIF or WebP image" },
          415,
        );
      }

      try {
        const path = await putUserAvatar(buildUserFs(ctx), {
          userId,
          bytes,
          contentType: type.mime,
          ext: type.ext,
        });
        return c.json({ url: userFsReadUrl(ctx.baseUrl, userId, path) });
      } catch (err) {
        return fsErrorResponse(c, err);
      }
    },
  );

  /**
   * The caller's stored pictures, newest first. Only the current one is
   * world-readable; the rest are served to their owner alone, which is exactly
   * who is asking here.
   */
  app.get("/avatars", async (c) => {
    const owner = requireOwner(c);
    if (!owner.ok) return owner.res;
    const ctx = c.get("studioContext");

    const avatars = await listUserAvatars(buildUserFs(ctx), owner.userId);
    return c.json({
      avatars: avatars.map((a) => ({
        ...a,
        url: userFsReadUrl(ctx.baseUrl, owner.userId, a.path),
      })),
    });
  });

  /** Re-pick a picture already in the history; answers with its URL. */
  app.post("/avatar/select", async (c) => {
    const owner = requireOwner(c);
    if (!owner.ok) return owner.res;
    const ctx = c.get("studioContext");

    const body = (await c.req.json().catch(() => null)) as {
      path?: unknown;
    } | null;
    if (typeof body?.path !== "string" || !body.path) {
      return c.json({ error: "Body must be { path: string }" }, 400);
    }

    try {
      await setCurrentAvatar(buildUserFs(ctx), owner.userId, body.path);
      return c.json({
        url: userFsReadUrl(ctx.baseUrl, owner.userId, body.path),
      });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  /**
   * With `?path=`, drop that one picture; without it, drop the whole history.
   * Clearing `user.image` is a separate Better Auth call the client makes
   * first, so a failure here leaves an unreferenced file rather than a
   * dangling URL.
   */
  app.delete("/avatar", async (c) => {
    const owner = requireOwner(c);
    if (!owner.ok) return owner.res;
    const ctx = c.get("studioContext");
    const fs = buildUserFs(ctx);

    const path = c.req.query("path");
    if (!path) {
      await pruneAvatars(fs, owner.userId);
      return c.json({ ok: true });
    }

    try {
      await deleteUserAvatar(fs, owner.userId, path);
      return c.json({ ok: true });
    } catch (err) {
      return fsErrorResponse(c, err);
    }
  });

  return app;
};
