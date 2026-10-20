import { ForbiddenError } from "../../core/access-control";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { canReadPersonal } from "../../file-storage/personal-home";
import { parseOrgFsKey } from "../../file-storage/org-fs-path";
import {
  GetObjectMetadataInputSchema,
  GetObjectMetadataOutputSchema,
  requireObjectStorage,
} from "./schema";

export const GET_OBJECT_METADATA = defineTool({
  name: "GET_OBJECT_METADATA",
  description: "Get metadata for an object in the organization's storage.",
  annotations: {
    title: "Get Object Metadata",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: GetObjectMetadataInputSchema,
  outputSchema: GetObjectMetadataOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();

    // Enforce the same personal-folder ACL the `/api/:org/fs` routes apply.
    const fsTarget = parseOrgFsKey(input.key);
    if (fsTarget) {
      const userId = getUserId(ctx);
      if (!userId || !canReadPersonal(fsTarget.volume, fsTarget.path, userId)) {
        throw new ForbiddenError("This file belongs to another member");
      }
    }

    const storage = requireObjectStorage(ctx);

    const result = await storage.head(input.key);

    return {
      contentType: result.contentType,
      contentLength: result.size,
      lastModified:
        result.lastModified?.toISOString?.() ??
        (typeof result.lastModified === "string"
          ? result.lastModified
          : new Date().toISOString()),
      etag: result.etag ?? "",
      metadata: result.metadata,
    };
  },
});
