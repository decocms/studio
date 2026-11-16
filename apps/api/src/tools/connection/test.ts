/**
 * CONNECTION_TEST Tool
 *
 * Test connection health
 */

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/studio-context";
import {
  ListToolsTimeoutError,
  listToolsWithTimeout,
} from "../../mcp-clients/list-tools-with-timeout";
import { guardAgainstPrivateUrl } from "../../mcp-clients/url-security";

const TEST_TIMEOUT_MS = 10_000;

const ReasonSchema = z.enum([
  "unauthorized",
  "timeout",
  "blocked_url",
  "unreachable",
]);

function reasonFor(error: unknown): z.infer<typeof ReasonSchema> {
  if (error instanceof ListToolsTimeoutError) return "timeout";
  if (
    error instanceof StreamableHTTPError &&
    (error.code === 401 || error.code === 403)
  ) {
    return "unauthorized";
  }
  return "unreachable";
}

export const CONNECTION_TEST = defineTool({
  name: "CONNECTION_TEST",
  description:
    "Test that a connection works: connects with the same credentials a tool call uses and lists its tools. On failure, reason says whether it needs authentication.",
  annotations: {
    title: "Test Connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    id: z.string(),
  }),

  outputSchema: z.object({
    id: z.string(),
    healthy: z.boolean(),
    latencyMs: z.number(),
    reason: ReasonSchema.optional(),
  }),

  handler: async (input, ctx) => {
    // Require organization context
    const organization = requireOrganization(ctx);

    // Check authorization
    await ctx.access.check();

    // Fetch connection to verify org ownership before testing
    const connection = await ctx.storage.connections.findById(input.id);
    if (!connection || connection.organization_id !== organization.id) {
      throw new Error("Connection not found");
    }

    const startTime = Date.now();
    const result = (reason?: z.infer<typeof ReasonSchema>) => ({
      id: input.id,
      healthy: !reason,
      latencyMs: Date.now() - startTime,
      ...(reason && { reason }),
    });

    // SSRF: connection_url is user-supplied.
    if (
      connection.connection_url &&
      (await guardAgainstPrivateUrl(connection.connection_url))
    ) {
      return result("blocked_url");
    }

    try {
      await listToolsWithTimeout(connection, ctx, TEST_TIMEOUT_MS);
      return result();
    } catch (error) {
      return result(reasonFor(error));
    }
  },
});
