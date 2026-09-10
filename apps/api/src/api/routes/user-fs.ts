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
  avatarExtension,
  buildUserFs,
  isValidUserVolume,
  MAX_AVATAR_BYTES,
  pruneAvatars,
  putUserAvatar,
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
      const ctx = c.get("studioContext");
      const userId = ctx.auth?.user?.id;
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      if (!isValidUserVolume(userId)) {
        return c.json({ error: "Unsupported user id" }, 400);
      }

      const contentType = c.req.header("content-type");
      const ext = avatarExtension(contentType);
      if (!ext) {
        return c.json(
          { error: "Avatar must be a PNG, JPEG, GIF or WebP image" },
          415,
        );
      }

      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength === 0) {
        return c.json({ error: "Empty request body" }, 400);
      }

      try {
        const path = await putUserAvatar(buildUserFs(ctx), {
          userId,
          bytes,
          contentType: contentType!.split(";")[0]!.trim().toLowerCase(),
          ext,
        });
        return c.json({ url: userFsReadUrl(ctx.baseUrl, userId, path) });
      } catch (err) {
        return fsErrorResponse(c, err);
      }
    },
  );

  /**
   * Drop the caller's stored avatar files. Clearing `user.image` is a separate
   * Better Auth call the client makes first, so a failure here leaves an
   * unreferenced file rather than a dangling URL.
   */
  app.delete("/avatar", async (c) => {
    const ctx = c.get("studioContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    if (!isValidUserVolume(userId)) {
      return c.json({ error: "Unsupported user id" }, 400);
    }

    await pruneAvatars(buildUserFs(ctx), userId);
    return c.json({ ok: true });
  });

  return app;
};
