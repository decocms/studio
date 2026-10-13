import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  assertNotOrgFsKey,
  clampExpiresIn,
  PutPresignedUrlInputSchema,
  PutPresignedUrlOutputSchema,
  requireObjectStorage,
} from "./schema";

const DEFAULT_EXPIRES_IN = 3600;

export const PUT_PRESIGNED_URL = defineTool({
  name: "PUT_PRESIGNED_URL",
  description:
    "Generate a presigned URL for uploading an object to the organization's storage. " +
    "Not for Library files: keys under `_fs/` are rejected because raw writes skip the file index " +
    "(use `PUT /api/<org>/fs/<volume>/file`).",
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
    requireOrganization(ctx);
    await ctx.access.check();
    assertNotOrgFsKey(input.key);
    const storage = requireObjectStorage(ctx);

    const expiresIn = clampExpiresIn(input.expiresIn, DEFAULT_EXPIRES_IN);
    const url = await storage.presignedPutUrl(
      input.key,
      expiresIn,
      input.contentType,
    );

    return { url, expiresIn };
  },
});
