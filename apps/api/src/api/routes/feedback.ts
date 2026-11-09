import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { FeedbackFields } from "./feedback-input";
import {
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_SCREENSHOT_TYPES,
} from "@decocms/shared/feedback";
import type { StudioContext } from "@/core/studio-context";
import { isAdminOrgId } from "@/core/task-board-admin";
import { getSettings } from "@/settings";
import { OrgFs, OrgFsQuotaError } from "@/file-storage/org-fs";
import {
  buildUserFs,
  isValidUserVolume,
  sniffAvatarType,
} from "@/file-storage/user-fs";
import { createBoundObjectStorage } from "@/object-storage/bound-object-storage";
import { DevObjectStorage } from "@/object-storage/dev-object-storage";
import { getObjectStorageS3Service } from "@/object-storage/factory";
import { notifyOrgFsChangeFromServer } from "@/file-storage/org-fs-notify";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";

const VOLUME = "feedback";

export const createFeedbackRoutes = () => {
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();
  app.post(
    "/feedback",
    bodyLimit({
      maxSize:
        FEEDBACK_MAX_SCREENSHOTS * FEEDBACK_MAX_SCREENSHOT_BYTES + 128 * 1024,
      onError: (c) => c.json({ error: "Feedback is too large" }, 413),
    }),
    async (c) => {
      const ctx = c.get("studioContext");
      const user = ctx.auth?.user;
      if (!user?.id) return c.json({ error: "Unauthorized" }, 401);
      if (!ctx.organization || !isValidUserVolume(user.id)) {
        return c.json({ error: "Invalid sender" }, 400);
      }
      const { feedbackOrgId, feedbackProjectId } = getSettings();
      if (
        !feedbackOrgId ||
        !feedbackProjectId ||
        !isAdminOrgId(feedbackOrgId) ||
        !ctx.db
      ) {
        return c.json({ error: "Feedback destination is not configured" }, 503);
      }
      const target = await ctx.db
        .selectFrom("organization")
        .select(["id", "slug"])
        .where("id", "=", feedbackOrgId)
        .executeTakeFirst();
      const project = await ctx.storage.virtualMcps.findById(feedbackProjectId);
      if (
        !target ||
        !project ||
        project.organization_id !== target.id ||
        (await ctx.storage.orgRepoSyncs.isSyncVolume(target.id, VOLUME))
      ) {
        return c.json({ error: "Feedback destination is invalid" }, 503);
      }
      let form: FormData;
      try {
        form = await c.req.raw.formData();
      } catch {
        return c.json({ error: "Expected multipart form data" }, 400);
      }
      if (
        [...form.keys()].some(
          (key) => !["message", "pageUrl", "screenshot"].includes(key),
        ) ||
        form.getAll("message").length !== 1 ||
        form.getAll("pageUrl").length !== 1
      ) {
        return c.json({ error: "Invalid feedback fields" }, 400);
      }
      const fields = FeedbackFields.safeParse({
        message: form.get("message"),
        pageUrl: form.get("pageUrl"),
      });
      const files = form.getAll("screenshot");
      if (!fields.success || files.length > FEEDBACK_MAX_SCREENSHOTS) {
        return c.json({ error: "Invalid feedback" }, 400);
      }
      const images: { bytes: Uint8Array; mime: string; ext: string }[] = [];
      for (const file of files) {
        if (
          !(file instanceof File) ||
          file.size === 0 ||
          file.size > FEEDBACK_MAX_SCREENSHOT_BYTES
        ) {
          return c.json({ error: "Invalid screenshot size" }, 400);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = sniffAvatarType(bytes);
        if (
          !type ||
          !FEEDBACK_SCREENSHOT_TYPES.includes(type.mime) ||
          file.type !== type.mime
        ) {
          return c.json({ error: "Invalid screenshot format" }, 400);
        }
        images.push({ bytes, ...type });
      }
      const personal = buildUserFs(ctx);
      const s3 = getObjectStorageS3Service();
      const destination = new OrgFs(
        s3
          ? createBoundObjectStorage(s3, target.id)
          : new DevObjectStorage(target.id, ctx.baseUrl),
        ctx.storage.orgFsEntries,
        target.id,
      );
      const submission = crypto.randomUUID();
      const written: { fs: OrgFs; volume: string; path: string }[] = [];
      const links: string[] = [];
      let committed = false;
      try {
        for (const [index, image] of images.entries()) {
          const path = `${submission}/${index}.${image.ext}`;
          const personalPath = `feedback/${path}`;
          // Track both copies so a failed submission can remove completed writes.
          written.push({ fs: personal, volume: user.id, path: personalPath });
          await personal.write(user.id, personalPath, image.bytes, {
            actor: user.id,
            contentType: image.mime,
          });
          written.push({ fs: destination, volume: VOLUME, path });
          await destination.write(VOLUME, path, image.bytes, {
            actor: "system",
            contentType: image.mime,
          });
          const url = `/api/${encodeURIComponent(target.slug)}/fs/${VOLUME}/read?path=${encodeURIComponent(path)}`;
          links.push(`![Screenshot ${index + 1}](${url})`);
        }
        const item = await ctx.storage.taskBoard.create({
          organizationId: target.id,
          virtualMcpId: project.id,
          title: `Feedback: ${fields.data.message.split("\n")[0]!.slice(0, 120)}`,
          description: [
            fields.data.message,
            `Sender: ${user.id}`,
            `Organization: ${ctx.organization.id}`,
            `Page: ${fields.data.pageUrl}`,
            ...links,
          ].join("\n\n"),
          status: "triage",
          by: "system",
        });
        committed = true;
        emitTaskBoardUpdated(target.id, item);
        await notifyOrgFsChangeFromServer(target.id, VOLUME).catch(() => {});
        return c.json({ ok: true }, 201);
      } catch (error) {
        if (!committed) {
          await Promise.allSettled(
            written.map(({ fs, volume, path }) =>
              fs.delete(volume, path, { actor: user.id }),
            ),
          );
        }
        if (error instanceof OrgFsQuotaError)
          return c.json({ error: "File storage quota exceeded" }, 413);
        return c.json({ error: "Could not submit feedback" }, 500);
      }
    },
  );
  return app;
};
