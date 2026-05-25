import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import {
  buildPublicUrl,
  presignPutUrl,
  resolveFileConfig,
} from "../../file-storage/file-config-s3";
import {
  MAX_UPLOAD_BYTES,
  UploadRejected,
  assertAllowed,
  buildObjectKey,
} from "../../file-storage/upload-policy";

export const FILE_PRESIGN_UPLOAD = defineTool({
  name: "FILE_PRESIGN_UPLOAD",
  description:
    "Generate a short-lived presigned PUT URL for uploading a file to a configured S3 bucket. The server picks the object key (org prefix + uuid + sanitized filename) and enforces a content-type allowlist and size cap; the signature binds the upload to the chosen content-type so the browser cannot lie post-signature.",
  inputSchema: z.object({
    configId: z.string().min(1),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    size: z
      .number()
      .int()
      .positive()
      .max(MAX_UPLOAD_BYTES, {
        message: `File too large (max ${MAX_UPLOAD_BYTES} bytes).`,
      }),
  }),
  outputSchema: z.object({
    uploadUrl: z.string(),
    key: z.string(),
    publicUrl: z.string(),
    contentType: z.string(),
    expiresInSeconds: z.number(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    try {
      assertAllowed(input.contentType, input.size);
    } catch (err) {
      if (err instanceof UploadRejected) {
        throw new Error(err.message);
      }
      throw err;
    }

    const fileCfg = await resolveFileConfig(
      ctx.storage.orgFileConfigs,
      input.configId,
      org.id,
    );

    const key = buildObjectKey({
      prefix: fileCfg.info.prefix,
      filename: input.filename,
    });

    const expiresInSeconds = 300;
    const uploadUrl = await presignPutUrl({
      ctx: fileCfg,
      key,
      contentType: input.contentType,
      expiresInSeconds,
    });

    return {
      uploadUrl,
      key,
      publicUrl: buildPublicUrl(fileCfg.info, key),
      contentType: input.contentType,
      expiresInSeconds,
    };
  },
});
