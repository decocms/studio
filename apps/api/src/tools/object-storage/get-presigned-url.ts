import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { parseOrgFsKey } from "../../file-storage/org-fs-path";
import {
  clampExpiresIn,
  GetPresignedUrlInputSchema,
  GetPresignedUrlOutputSchema,
  requireObjectStorage,
  requireOrgFsRead,
} from "./schema";

const DEFAULT_EXPIRES_IN = 3600;

export const GET_PRESIGNED_URL = defineTool({
  name: "GET_PRESIGNED_URL",
  description:
    "Generate a presigned URL for downloading an object from the organization's storage.",
  annotations: {
    title: "Get Presigned Download URL",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: GetPresignedUrlInputSchema,
  outputSchema: GetPresignedUrlOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    const fsTarget = parseOrgFsKey(input.key);
    if (fsTarget) {
      requireOrgFsRead(ctx, fsTarget);
    }

    const storage = requireObjectStorage(ctx);
    const expiresIn = clampExpiresIn(input.expiresIn, DEFAULT_EXPIRES_IN);
    const url = await storage.presignedGetUrl(input.key, expiresIn);

    return { url, expiresIn };
  },
});
