import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  PutPresignedUrlInputSchema,
  PutPresignedUrlOutputSchema,
  requireObjectStorage,
} from "./schema";

const DEFAULT_EXPIRES_IN = 3600;

export const PUT_PRESIGNED_URL = defineTool({
  name: "PUT_PRESIGNED_URL",
  description:
    "Generate a presigned URL for uploading an object to the organization's storage.",
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
    const storage = requireObjectStorage(ctx);

    const expiresIn = input.expiresIn ?? DEFAULT_EXPIRES_IN;
    const url = await storage.presignedPutUrl(
      input.key,
      expiresIn,
      input.contentType,
    );

    return { url, expiresIn };
  },
});
