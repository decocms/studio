import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { query } from "@anthropic-ai/claude-agent-sdk";

export const AI_PROVIDER_CLI_ACTIVATE = defineTool({
  name: "AI_PROVIDER_CLI_ACTIVATE",
  description:
    "Check if the Claude Code CLI is installed and authenticated, then activate the provider.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    activated: z.boolean(),
    email: z.string().optional(),
    error: z.string().optional(),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    // Check if Claude Code SDK is available and authenticated
    let email: string | undefined;
    try {
      const q = query({ prompt: "", options: { maxTurns: 1 } });
      const info = await q.accountInfo();
      q.return(undefined);

      if (!info.email) {
        return {
          activated: false,
          error: "Claude Code is not authenticated. Run: claude auth login",
        };
      }
      email = info.email;
    } catch {
      return {
        activated: false,
        error:
          "Claude Code is not available. Install from https://docs.anthropic.com/en/docs/claude-code/overview",
      };
    }

    // Upsert key record — idempotent even under concurrent calls
    await ctx.storage.aiProviderKeys.upsert({
      providerId: "claude-code",
      label: "Claude CLI",
      apiKey: "cli-local",
      organizationId: org.id,
      createdBy: ctx.auth.user!.id,
    });

    return { activated: true, email };
  },
});
