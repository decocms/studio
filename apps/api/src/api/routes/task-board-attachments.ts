/**
 * Task board attachment bytes.
 *
 * Route: GET /api/:org/task-board/attachments/:id
 *
 * Uploads go through the TASK_BOARD_ATTACHMENT_ADD / TASK_BOARD_COMMENT_CREATE
 * tools (base64, size-capped); this route only streams the stored bytes back
 * so <img> tags and download links work. Org membership is enforced by
 * `resolveOrgFromPath` on the org-scoped sub-app; the storage read is
 * additionally keyed by the resolved org id.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { StudioContext } from "@/core/studio-context";

type Variables = { studioContext: StudioContext };

/** Only render-safe media inline; everything else downloads. */
const INLINE_MIME = /^(image\/|video\/|audio\/|application\/pdf$|text\/plain$)/;

export const createTaskBoardAttachmentRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/task-board/attachments/:id", async (c) => {
    const ctx = c.get("studioContext");
    if (!ctx.auth?.user?.id) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const orgId = ctx.organization?.id;
    if (!orgId) {
      throw new HTTPException(400, { message: "Organization required" });
    }

    const id = c.req.param("id");
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new HTTPException(400, { message: "Invalid attachment ID" });
    }

    const attachment = await ctx.storage.taskBoard.getAttachment(id, orgId);
    if (!attachment) {
      throw new HTTPException(404, { message: "Attachment not found" });
    }

    const { meta, data } = attachment;
    // Re-view over a plain ArrayBuffer — Hono's Data type rejects a
    // SharedArrayBuffer-backed view, which pg's driver types don't rule out.
    const body = new Uint8Array(data.slice().buffer) as Uint8Array<ArrayBuffer>;
    const inline = INLINE_MIME.test(meta.mimeType);
    // RFC 5987 filename* handles non-ASCII names; plain filename is a fallback.
    const asciiName = meta.filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/"/g, "'");
    return c.body(body, 200, {
      "Content-Type": inline ? meta.mimeType : "application/octet-stream",
      "Content-Length": String(meta.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      // Attachment bytes are immutable (delete + re-add mints a new id).
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
  });

  return app;
};
