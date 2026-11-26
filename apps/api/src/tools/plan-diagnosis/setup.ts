import {
  getWellKnownPlanDiagnosisConnection,
  PLAN_DIAGNOSIS_SCOPES,
  type PlanDiagnosisState,
  WellKnownOrgMCPId,
} from "@decocms/shared/sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { InvalidInputError } from "../../core/invalid-input-error";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { invalidateConnectionCaches } from "../../mcp-clients/mcp-cache-invalidation";
import {
  injectSelfSentinel,
  validateConfiguration,
} from "../connection/credential-grants";
import { saveConnectionWithConfiguration } from "../connection/save-configuration";
import { planDiagnosisAvailability } from "./config";

export const PLAN_DIAGNOSIS_SETUP = defineTool({
  name: "PLAN_DIAGNOSIS_SETUP",
  description:
    "Connect the store diagnosis behind the Plan page to the organization's BigQuery connection and the dataset holding the store's GA4 export. With `plan_engine_native` the binding is saved for the diagnosis inside Studio and `connection_id` is null; otherwise it creates the organization's diagnosis connection, or updates it when it exists. Fails with `flag_off` when the Plan page is off and `service_unset` when this deployment has no diagnosis service.",
  annotations: {
    title: "Set Up Store Diagnosis",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    bigquery_connection_id: z
      .string()
      .min(1)
      .describe("This organization's BigQuery connection."),
    bigquery_project_id: z
      .string()
      .min(1)
      .describe("Google Cloud project that holds the GA4 export."),
    bigquery_dataset_id: z
      .string()
      .min(1)
      .describe("BigQuery dataset of the GA4 export, such as analytics_123."),
  }),
  outputSchema: z.object({
    connection_id: z
      .string()
      .nullable()
      .describe(
        "The external engine's connection; null when the diagnosis runs inside Studio.",
      ),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("A signed-in user is required");

    const availability = await planDiagnosisAvailability(ctx, organization.id);
    if (!availability.ok) {
      throw new Error(
        availability.reason === "flag_off"
          ? "flag_off: the Plan page is not enabled for this organization"
          : "service_unset: this deployment has no store diagnosis service",
      );
    }

    const bigquery = await ctx.storage.connections.findById(
      input.bigquery_connection_id,
      organization.id,
    );
    if (!bigquery) {
      throw new InvalidInputError(
        `BigQuery connection not found: ${input.bigquery_connection_id}`,
      );
    }

    if (availability.engine === "native") {
      await ctx.storage.planEngine.saveBigQueryBinding(organization.id, {
        connectionId: bigquery.id,
        projectId: input.bigquery_project_id,
        datasetId: input.bigquery_dataset_id,
      });
      return { connection_id: null };
    }

    const id = WellKnownOrgMCPId.PLAN_DIAGNOSIS(organization.id);
    const existing = await ctx.storage.connections.findById(
      id,
      organization.id,
    );
    const state: PlanDiagnosisState = {
      // Keeps the engine's optional settings made on the connection itself.
      ...existing?.configuration_state,
      BIGQUERY: { __type: "google-big-query", value: bigquery.id },
      bigqueryProjectId: input.bigquery_project_id,
      bigqueryDatasetId: input.bigquery_dataset_id,
    };
    const scopes = [
      ...new Set([
        ...(existing?.configuration_scopes ?? []),
        ...PLAN_DIAGNOSIS_SCOPES,
      ]),
    ];
    injectSelfSentinel(state, scopes, organization.id);
    await validateConfiguration(state, scopes, organization.id, ctx);

    // A new row counts as unconfigured, so the engine gets firstRun.
    const previous = existing ?? {
      ...(await ctx.storage.connections.create({
        ...getWellKnownPlanDiagnosisConnection(
          organization.id,
          availability.url,
          state,
        ),
        organization_id: organization.id,
        created_by: userId,
      })),
      configuration_state: null,
      configuration_scopes: null,
    };

    const connection = await saveConnectionWithConfiguration(ctx, {
      organization,
      userId,
      existing: previous,
      update: {
        connection_url: availability.url,
        configuration_state: state,
        configuration_scopes: scopes,
        updated_by: userId,
      },
      configurationChanged: true,
    });
    invalidateConnectionCaches(connection.id);

    return { connection_id: connection.id };
  },
});
