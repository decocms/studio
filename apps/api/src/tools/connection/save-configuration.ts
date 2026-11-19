/**
 * Saving a connection's configuration: the credential grants its scopes
 * imply, a workload token when it holds grants and has no active token, the
 * downstream's ON_MCP_CONFIGURATION, and then the row. A failing step undoes
 * the vault writes before it, so the caller sees the save land whole or not
 * at all.
 */

import type { ConnectionEntity } from "@decocms/shared/sdk";
import type {
  OrganizationScope,
  StudioContext,
} from "../../core/studio-context";
import { deriveCredentialGrants } from "./credential-grants";
import {
  type McpConfigurationVaultBootstrap,
  notifyMcpConfiguration,
} from "./on-configuration";

export async function saveConnectionWithConfiguration(
  ctx: StudioContext,
  params: {
    organization: OrganizationScope;
    userId: string;
    existing: ConnectionEntity;
    /** The row's new fields, including the configuration it ends up with. */
    update: Partial<ConnectionEntity> & {
      configuration_state: Record<string, unknown>;
      configuration_scopes: string[];
    };
    /** Whether the configuration differs from `existing`'s; false skips the vault and the callback. */
    configurationChanged: boolean;
  },
): Promise<ConnectionEntity> {
  const { organization, userId, existing, update, configurationChanged } =
    params;
  const id = existing.id;
  const finalState = update.configuration_state;
  const finalScopes = update.configuration_scopes;

  const credentialGrants = configurationChanged
    ? deriveCredentialGrants(finalState, finalScopes)
    : [];
  const previousCredentialGrants = configurationChanged
    ? deriveCredentialGrants(
        (existing.configuration_state ?? {}) as Record<string, unknown>,
        existing.configuration_scopes ?? [],
      )
    : [];
  // firstRun fires the MCP's onInstall hook exactly once: true when the
  // connection had no prior configuration_state (its first config save).
  const priorState = existing.configuration_state as Record<
    string,
    unknown
  > | null;
  const firstRun = priorState == null || Object.keys(priorState).length === 0;
  let vaultBootstrap: McpConfigurationVaultBootstrap | undefined;
  let createdWorkloadTokenId: string | undefined;

  const restorePreviousCredentialGrants = async () => {
    try {
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: organization.id,
        subjectConnectionId: id,
        createdBy: userId,
        grants: previousCredentialGrants,
      });
    } catch (restoreError) {
      console.error(
        "Failed to restore credential grants after credential vault mutation failed",
        restoreError,
      );
    }
  };

  const connectionForCallback = {
    ...existing,
    ...update,
  } as ConnectionEntity;

  if (configurationChanged) {
    try {
      await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
        organizationId: organization.id,
        subjectConnectionId: id,
        createdBy: userId,
        grants: credentialGrants,
      });

      if (credentialGrants.length > 0) {
        const activeToken =
          await ctx.storage.connectionCredentialVault.findActiveWorkloadToken({
            organizationId: organization.id,
            subjectConnectionId: id,
          });

        if (!activeToken) {
          const { plaintextToken, record } =
            await ctx.storage.connectionCredentialVault.createOrRotateWorkloadToken(
              {
                organizationId: organization.id,
                subjectConnectionId: id,
              },
            );
          createdWorkloadTokenId = record.id;
          vaultBootstrap = {
            baseUrl: ctx.baseUrl,
            org: organization.slug ?? organization.id,
            subjectConnectionId: id,
            token: plaintextToken,
          };
        }
      }
    } catch (error) {
      if (createdWorkloadTokenId) {
        await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
          organizationId: organization.id,
          subjectConnectionId: id,
          tokenId: createdWorkloadTokenId,
        });
      }
      await restorePreviousCredentialGrants();
      throw error;
    }
  }

  // Invoke ON_MCP_CONFIGURATION callback if configuration was updated
  // Ignore errors but await for the response before responding
  if (configurationChanged) {
    try {
      await notifyMcpConfiguration(ctx, connectionForCallback, {
        state: finalState,
        scopes: finalScopes,
        firstRun,
        ...(vaultBootstrap ? { vault: vaultBootstrap } : {}),
      });
    } catch (error) {
      console.error("Failed to invoke ON_MCP_CONFIGURATION callback", error);
      if (createdWorkloadTokenId) {
        await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
          organizationId: organization.id,
          subjectConnectionId: id,
          tokenId: createdWorkloadTokenId,
        });
      }
      // Nothing to restore when the update carried no credential grants.
      if (credentialGrants.length > 0) {
        await restorePreviousCredentialGrants();
        throw error;
      }
    }
  }

  // Update the connection after any required vault bootstrap succeeds. This
  // keeps mixed updates atomic from the caller's point of view when bootstrap
  // plaintext would otherwise be lost.
  try {
    return await ctx.storage.connections.update(id, update);
  } catch (error) {
    if (configurationChanged) {
      if (createdWorkloadTokenId) {
        await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
          organizationId: organization.id,
          subjectConnectionId: id,
          tokenId: createdWorkloadTokenId,
        });
      }
      await restorePreviousCredentialGrants();
    }
    throw error;
  }
}
