import { defineTool } from "../../core/define-tool";
import { getPublicUrl } from "../../core/server-constants";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { parseOrgFsKey } from "../../file-storage/org-fs-path";
import {
  mintOrgFsUploadToken,
  ORG_FS_UPLOAD_MAX_TTL_SEC,
} from "../../file-storage/upload-grant";
import {
  clampExpiresIn,
  PutPresignedUrlInputSchema,
  PutPresignedUrlOutputSchema,
  requireObjectStorage,
  requireOrgFsWrite,
} from "./schema";

const DEFAULT_EXPIRES_IN = 3600;

export const PUT_PRESIGNED_URL = defineTool({
  name: "PUT_PRESIGNED_URL",
  description:
    "Generate a presigned URL for uploading an object to the organization's storage. " +
    "A `_fs/<volume>/<path>` key is a Library file: the URL then uploads through Studio so the " +
    "file shows up in the Library, and lasts at most an hour.",
  annotations: {
    title: "Get Presigned Upload URL",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: PutPresignedUrlInputSchema,
  outputSchema: PutPresignedUrlOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const expiresIn = clampExpiresIn(input.expiresIn, DEFAULT_EXPIRES_IN);
    const fsTarget = parseOrgFsKey(input.key);
    if (fsTarget) {
      const { organizationId, userId, volume, path } = await requireOrgFsWrite(
        ctx,
        fsTarget,
      );
      const ttl = Math.min(expiresIn, ORG_FS_UPLOAD_MAX_TTL_SEC);
      const token = mintOrgFsUploadToken({
        organizationId,
        volume,
        path,
        userId,
        expiresAt: Date.now() + ttl * 1000,
      });
      const orgRef = encodeURIComponent(org.slug ?? org.id);
      return {
        url: `${getPublicUrl()}/api/${orgRef}/fs/${volume}/upload/${token}`,
        expiresIn: ttl,
      };
    }

    const storage = requireObjectStorage(ctx);
    const url = await storage.presignedPutUrl(
      input.key,
      expiresIn,
      input.contentType,
    );

    return { url, expiresIn };
  },
});
