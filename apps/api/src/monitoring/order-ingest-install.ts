/**
 * The order ingest a VTEX connection gets once it has its keys: the install
 * that feeds the Monitor's order rules. Made when the VTEX connection is saved,
 * so a store whose keys were entered anywhere is watched without a separate
 * "Connect store".
 */

import type { ConnectionEntity } from "@decocms/shared/sdk";
import { orgHasFeature } from "@/core/plan-feature-gate";
import type { OrganizationScope, StudioContext } from "@/core/studio-context";
import { isCustomerLakeConfigured } from "@/customer-lake/client";
import { invalidateConnectionCaches } from "@/mcp-clients/mcp-cache-invalidation";
import { getSettings } from "@/settings";
import { CREDENTIAL_CONFIGURATION_READ_SCOPE } from "@/storage/connection-credential-vault";
import { validateConfiguration } from "@/tools/connection/credential-grants";
import { saveConnectionWithConfiguration } from "@/tools/connection/save-configuration";

const VTEX_APP_ID = "deco/vtex";
const INGEST_TITLE = "VTEX order monitoring";
/** What the ingest declares: reading its VTEX connection's key from the vault. */
const INGEST_SCOPES = [`VTEX::${CREDENTIAL_CONFIGURATION_READ_SCOPE}`];

type ConfiguredConnection = Pick<
  ConnectionEntity,
  "app_id" | "app_name" | "configuration_state"
>;

function isVtexWithKeys(connection: ConfiguredConnection): boolean {
  if (connection.app_id !== VTEX_APP_ID && connection.app_name !== "vtex") {
    return false;
  }
  const state = connection.configuration_state;
  return !!state?.accountName && !!state.appKey && !!state.appToken;
}

/** The VTEX connection an ingest is bound to, as its config form saves it. */
function boundTo(ingest: ConnectionEntity): unknown {
  const binding = ingest.configuration_state?.VTEX;
  return binding && typeof binding === "object" && "value" in binding
    ? binding.value
    : undefined;
}

/** One per VTEX connection, so two saves racing to install it collide on the id. */
export function orderIngestId(vtexConnectionId: string): string {
  return `${vtexConnectionId}_order_ingest`;
}

/**
 * Installs the order ingest on `connection` when it is a VTEX connection with
 * its keys, the monitor runs on this deployment and the org's plan includes
 * it. Best-effort: the VTEX save that calls this has already landed, so a
 * failure (a key VTEX rejects, an ingest that is down) is logged, not thrown.
 */
export async function provisionOrderIngest(
  ctx: StudioContext,
  params: {
    organization: OrganizationScope;
    userId: string;
    connection: ConnectionEntity;
  },
): Promise<void> {
  if (!isVtexWithKeys(params.connection)) return;
  const ingestUrl = getSettings().orderMonitorIngestUrl;
  if (!ingestUrl || !isCustomerLakeConfigured()) return;
  try {
    if (!(await orgHasFeature(ctx, params.organization.id, "monitoring"))) {
      return;
    }
    await ensureOrderIngest(ctx, { ...params, ingestUrl });
  } catch (error) {
    console.error(
      "[order-ingest] installing the order ingest on a VTEX connection failed",
      { connectionId: params.connection.id },
      error,
    );
  }
}

/**
 * The install itself, past the deployment and plan gates: reuses an ingest
 * already bound to this VTEX connection (no-op) or an unbound one, else
 * creates one, then saves its binding, which leases the VTEX key and has the
 * ingest register the store's order hook. An ingest created here that fails
 * to bind is deleted, so no store lists that never gets data.
 */
async function ensureOrderIngest(
  ctx: StudioContext,
  params: {
    organization: OrganizationScope;
    userId: string;
    connection: ConnectionEntity;
    ingestUrl: string;
  },
): Promise<void> {
  const { organization, userId, connection: vtex, ingestUrl } = params;
  const { items: ingests } = await ctx.storage.connections.list(
    organization.id,
    { where: { field: ["connection_url"], operator: "eq", value: ingestUrl } },
  );
  if (ingests.some((c) => boundTo(c) === vtex.id)) return;

  let ingest = ingests.find((c) => boundTo(c) === undefined);
  const created = !ingest;
  if (!ingest) {
    const id = orderIngestId(vtex.id);
    try {
      ingest = await ctx.storage.connections.createNew({
        id,
        organization_id: organization.id,
        created_by: userId,
        title: INGEST_TITLE,
        connection_type: "HTTP",
        connection_url: ingestUrl,
        connection_token: null,
        tools: null,
      });
    } catch (error) {
      // Another save of this VTEX connection is installing it.
      if (await ctx.storage.connections.findById(id, organization.id)) return;
      throw error;
    }
  }

  const state = { VTEX: { __type: "vtex", value: vtex.id } };
  try {
    await validateConfiguration(state, INGEST_SCOPES, organization.id, ctx);
    const bound = await saveConnectionWithConfiguration(ctx, {
      organization,
      userId,
      existing: ingest,
      update: {
        configuration_state: state,
        configuration_scopes: INGEST_SCOPES,
        updated_by: userId,
      },
      configurationChanged: true,
    });
    invalidateConnectionCaches(bound.id);
  } catch (error) {
    if (created) await ctx.storage.connections.delete(ingest.id);
    throw error;
  }
}
