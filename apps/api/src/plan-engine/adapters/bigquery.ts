/**
 * The org's GA4 export in BigQuery, read through the org's BigQuery
 * connection: its `bigquery_query` tool, called server-side as the member who
 * started the run.
 */

import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { clientFromConnection } from "@/mcp-clients";
import type { BigQueryBinding } from "@/storage/plan-engine";
import type { BigQueryRunner } from "../ports.ts";

/** What PLAN_DIAGNOSIS_SETUP saves on the external engine's plan-diagnosis connection. */
const LegacyBindingSchema = z.object({
  BIGQUERY: z.object({ value: z.string().min(1) }),
  bigqueryProjectId: z.string().min(1),
  bigqueryDatasetId: z.string().min(1),
});

/**
 * Which BigQuery connection and GA4 dataset the engine reads: what
 * PLAN_DIAGNOSIS_SETUP saved for the built-in engine, else what it saved on
 * the external engine's connection, so an org set up there need not redo it.
 * null when nothing is bound.
 */
export async function planBigQueryBinding(
  ctx: StudioContext,
  orgId: string,
): Promise<BigQueryBinding | null> {
  const saved = await ctx.storage.planEngine.getBigQueryBinding(orgId);
  if (saved) return saved;
  const connection = await ctx.storage.connections.findById(
    WellKnownOrgMCPId.PLAN_DIAGNOSIS(orgId),
    orgId,
  );
  return connectionBigQueryBinding(connection?.configuration_state);
}

/** The binding saved in the plan-diagnosis connection's `configuration_state`; null when it holds none. */
export function connectionBigQueryBinding(
  state: unknown,
): BigQueryBinding | null {
  const parsed = LegacyBindingSchema.safeParse(state);
  if (!parsed.success) return null;
  return {
    connectionId: parsed.data.BIGQUERY.value,
    projectId: parsed.data.bigqueryProjectId,
    datasetId: parsed.data.bigqueryDatasetId,
  };
}

const errorText = (value: unknown) =>
  `Tool bigquery_query returned an error: ${JSON.stringify(value)}`;

function toolResult(result: Record<string, unknown>): unknown {
  if (result.isError) {
    throw new Error(errorText(result.structuredContent ?? result.content));
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text =
    first && typeof first === "object" && "text" in first
      ? first.text
      : undefined;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The run's BigQuery, or null when the org has none bound (a named gap). */
export async function orgBigQuery(
  ctx: StudioContext,
  orgId: string,
): Promise<{
  run: BigQueryRunner;
  projectId: string;
  datasetId: string;
} | null> {
  const binding = await planBigQueryBinding(ctx, orgId);
  if (!binding) return null;
  const run: BigQueryRunner = async (args) => {
    const connection = await ctx.storage.connections.findById(
      binding.connectionId,
      orgId,
    );
    if (!connection) {
      throw new Error(
        `a conexão do BigQuery (${binding.connectionId}) não existe mais`,
      );
    }
    const client = await clientFromConnection(connection, ctx, false);
    return toolResult(
      await client.callTool({ name: "bigquery_query", arguments: args }),
    );
  };
  return {
    run,
    projectId: binding.projectId,
    datasetId: binding.datasetId,
  };
}
