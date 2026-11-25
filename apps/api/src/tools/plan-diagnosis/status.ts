import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { planDiagnosisAvailability } from "./config";

const BoundBigQuerySchema = z.object({
  BIGQUERY: z.object({ value: z.string().min(1) }),
  bigqueryProjectId: z.string().min(1),
  bigqueryDatasetId: z.string().min(1),
});

const StatusSchema = z.object({
  configured: z.boolean(),
  connection_id: z.string().nullable(),
  reason: z.enum(["flag_off", "service_unset", "not_connected"]).optional(),
});

export const PLAN_DIAGNOSIS_STATUS = defineTool({
  name: "PLAN_DIAGNOSIS_STATUS",
  description:
    "Whether the store diagnosis behind the Plan page is set up for this organization. `reason` says why not: `flag_off` (the Plan page is off), `service_unset` (this deployment has no diagnosis service) or `not_connected` (no BigQuery dataset is connected, or its connection is gone). Read-only.",
  annotations: {
    title: "Store Diagnosis Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: StatusSchema,

  handler: async (_input, ctx): Promise<z.infer<typeof StatusSchema>> => {
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

    const state = BoundBigQuerySchema.safeParse(connection.configuration_state);
    const bigquery =
      state.success &&
      (await ctx.storage.connections.findById(
        state.data.BIGQUERY.value,
        organization.id,
      ));
    return bigquery
      ? { configured: true, connection_id: connection.id }
      : {
          configured: false,
          connection_id: connection.id,
          reason: "not_connected",
        };
  },
});
