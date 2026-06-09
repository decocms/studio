import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { getChannelAdapter } from "@/channels/registry";
import { channelStatusSchema } from "./shared";

/**
 * Probe a channel's credentials against the platform. On success the channel is
 * flipped from `draft` to `active`; on failure it is marked `error`.
 */
export const CHANNEL_TEST = defineTool({
  name: "CHANNEL_TEST",
  description:
    "Test a channel's credentials against the platform and activate it on success.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({
    ok: z.boolean(),
    status: channelStatusSchema,
    message: z.string().optional(),
    botDisplayName: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const { info, credentials } = await ctx.storage.channels.resolve(
      input.id,
      org.id,
    );
    if (!credentials) {
      return {
        ok: false,
        status: "draft" as const,
        message: "Add credentials before testing the connection.",
      };
    }

    const adapter = getChannelAdapter(info.channelType);
    const result = await adapter.testConnection(credentials);

    const status = result.ok ? ("active" as const) : ("error" as const);
    const metadata = result.botDisplayName
      ? { ...(info.metadata ?? {}), botDisplayName: result.botDisplayName }
      : info.metadata;
    await ctx.storage.channels.update(input.id, org.id, { status, metadata });

    return {
      ok: result.ok,
      status,
      message: result.detail,
      botDisplayName: result.botDisplayName,
    };
  },
});
