import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  connectionBigQueryBinding,
  planBigQueryBinding,
} from "../../plan-engine/adapters/bigquery";
import { planDiagnosisAvailability } from "./config";

const StatusSchema = z.object({
  configured: z.boolean(),
  connection_id: z.string().nullable(),
  reason: z.enum(["flag_off", "service_unset", "not_connected"]).optional(),
});

type Status = z.infer<typeof StatusSchema>;

export const PLAN_DIAGNOSIS_STATUS = defineTool({
  name: "PLAN_DIAGNOSIS_STATUS",
  description:
    "Whether the store diagnosis behind the Plan page is set up for this organization. `connection_id` is the external engine's connection; null when the diagnosis runs inside Studio (`plan_engine_native`). `reason` says why not: `flag_off` (the Plan page is off), `service_unset` (this deployment has no diagnosis service) or `not_connected` (no BigQuery dataset is connected, or its connection is gone). Read-only.",
  annotations: {
    title: "Store Diagnosis Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: StatusSchema,

  handler: async (_input, ctx): Promise<Status> => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const availability = await planDiagnosisAvailability(ctx, organization.id);
    if (!availability.ok) {
      return {
        configured: false,
        connection_id: null,
        reason: availability.reason,
      };
    }

    const bigQueryExists = async (connectionId: string | undefined) =>
      connectionId !== undefined &&
      (await ctx.storage.connections.findById(
        connectionId,
        organization.id,
      )) !== null;

    if (availability.engine === "native") {
      const binding = await planBigQueryBinding(ctx, organization.id);
      return (await bigQueryExists(binding?.connectionId))
        ? { configured: true, connection_id: null }
        : { configured: false, connection_id: null, reason: "not_connected" };
    }

    const connection = await ctx.storage.connections.findById(
      WellKnownOrgMCPId.PLAN_DIAGNOSIS(organization.id),
      organization.id,
    );
    if (!connection) {
      return {
        configured: false,
        connection_id: null,
        reason: "not_connected",
      };
    }
    const binding = connectionBigQueryBinding(connection.configuration_state);
    return (await bigQueryExists(binding?.connectionId))
      ? { configured: true, connection_id: connection.id }
      : {
          configured: false,
          connection_id: connection.id,
          reason: "not_connected",
        };
  },
});
