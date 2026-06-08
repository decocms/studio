import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  ListObjectsInputSchema,
  ListObjectsOutputSchema,
  requireObjectStorage,
} from "./schema";

export const LIST_OBJECTS = defineTool({
  name: "LIST_OBJECTS",
  description:
    "List objects in the organization's object storage with pagination and prefix filtering support.",
  annotations: {
    title: "List Objects",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ListObjectsInputSchema,
  outputSchema: ListObjectsOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const storage = requireObjectStorage(ctx);

    const result = await storage.list({
      prefix: input.prefix,
      maxKeys: input.maxKeys,
      continuationToken: input.continuationToken,
      delimiter: input.delimiter,
    });

    return {
      objects: result.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
        lastModified:
          obj.lastModified?.toISOString?.() ??
          (typeof obj.lastModified === "string"
            ? obj.lastModified
            : new Date().toISOString()),
        etag: obj.etag ?? "",
      })),
      isTruncated: result.isTruncated,
      nextContinuationToken: result.nextContinuationToken,
      commonPrefixes: result.commonPrefixes,
    };
  },
});
