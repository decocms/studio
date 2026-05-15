/**
 * system-health built-in tools.
 *
 * Per-run injection. Attached by dispatchRun when the agent id resolves
 * to a sysh vmcp (`getSystemHealthAgentConnectionId` is non-null).
 *
 * The wrapper exists so the agent doesn't have to know its own
 * `virtual_mcp_id` or look up its underlying connection id — both are
 * captured at injection time from the closure.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MeshContext } from "@/core/mesh-context";

const CreateHealthAutomationInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .describe("Short label for the automation, shown in the user's list."),
  instructions: z
    .string()
    .min(1)
    .describe(
      "What to do when the trigger fires. Becomes the automation's user " +
        "message — write it as if you're handing the task to a fresh run " +
        "of yourself. The run starts with no prior conversation, so " +
        "include any context the new run needs to act.",
    ),
  trigger: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("cron"),
        cron_expression: z
          .string()
          .describe(
            "Standard 5-field cron expression in UTC. Minimum interval " +
              "between fires is 5 minutes.",
          ),
      }),
      z.object({
        type: z.literal("event"),
        event_type: z
          .string()
          .describe(
            "Event type to subscribe to on the system-health connection. " +
              "Call TRIGGER_LIST on the system-health connection first to " +
              "see which types are available.",
          ),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Trigger parameters, shaped per the trigger definition " +
              "returned by TRIGGER_LIST.",
          ),
      }),
    ])
    .describe("How the automation gets triggered."),
});

export function createSystemHealthTools(
  ctx: MeshContext,
  agentId: string,
  connectionId: string,
) {
  return {
    create_health_automation: tool({
      description:
        "Schedule a recurring run (cron) or subscribe to an event from " +
        "the system-health connection (event). When the trigger fires, " +
        "a fresh run of this agent starts with the instructions you " +
        "provide. Use cron for periodic sweeps (e.g. a daily health " +
        "summary). Use event for reactive triage — call TRIGGER_LIST " +
        "on the system-health connection first to discover event types.",
      inputSchema: zodSchema(CreateHealthAutomationInputSchema),
      execute: async (input) => {
        // Lazy import: AUTOMATION_TRIGGER_ADD pulls in configure-trigger →
        // api/routes/proxy → tools/index, which would create a module-init
        // cycle through this file's parent (dispatch-run). Resolving at
        // call time breaks the cycle; modules are cached after first use.
        const [
          { AUTOMATION_CREATE },
          { AUTOMATION_TRIGGER_ADD },
          { AUTOMATION_DELETE },
        ] = await Promise.all([
          import("@/tools/automations/create"),
          import("@/tools/automations/trigger-add"),
          import("@/tools/automations/delete"),
        ]);

        let automationId: string | null = null;
        try {
          const automation = await AUTOMATION_CREATE.execute(
            {
              name: input.name,
              virtual_mcp_id: agentId,
              messages: input.instructions,
              models: { tier: "smart" as const },
              temperature: 0.5,
              active: true,
            },
            ctx,
          );
          automationId = automation.id;

          const trigger =
            input.trigger.type === "cron"
              ? await AUTOMATION_TRIGGER_ADD.execute(
                  {
                    automation_id: automation.id,
                    type: "cron",
                    cron_expression: input.trigger.cron_expression,
                  },
                  ctx,
                )
              : await AUTOMATION_TRIGGER_ADD.execute(
                  {
                    automation_id: automation.id,
                    type: "event",
                    connection_id: connectionId,
                    event_type: input.trigger.event_type,
                    params: input.trigger.params,
                  },
                  ctx,
                );

          return {
            success: true,
            automation_id: automation.id,
            trigger_id: trigger.id,
          };
        } catch (err) {
          // Trigger creation is the failure-prone step (it calls
          // TRIGGER_CONFIGURE on the upstream MCP). If we already created
          // the automation row, roll it back — otherwise the user ends up
          // with an orphan automation that never fires and they can't
          // see why. Log loudly so server-side debug works without
          // forcing the agent to surface the error.
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[create_health_automation] failed (automationId=${automationId ?? "none"}):`,
            err,
          );
          if (automationId) {
            try {
              await AUTOMATION_DELETE.execute({ id: automationId }, ctx);
            } catch (rollbackErr) {
              console.error(
                `[create_health_automation] rollback of automation ${automationId} failed:`,
                rollbackErr,
              );
            }
          }
          return { success: false, error: message };
        }
      },
    }),
  };
}
