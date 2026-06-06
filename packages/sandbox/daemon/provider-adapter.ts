/**
 * Minimal aiProviders adapter for the daemon's HarnessContext.
 *
 * The daemon does not have vault access; it receives the provider secret via
 * mcp.modelSecret. This adapter matches the providerId to the in-tree
 * ProviderAdapter registry and constructs a MeshProvider from the raw key.
 *
 * Only the main chat-completion provider is ever activated this way — sub-
 * providers (image, deep-research) stay cluster-side (spec §3.8).
 *
 * We import the individual adapters directly (rather than the cluster's
 * getProviders() which calls getSettings()) to avoid pulling in the cluster's
 * settings pipeline and its environment variable dependencies.
 */

import { anthropicAdapter } from "../../../apps/mesh/src/ai-providers/adapters/anthropic";
import { googleAdapter } from "../../../apps/mesh/src/ai-providers/adapters/google";
import { openaiCompatibleAdapter } from "../../../apps/mesh/src/ai-providers/adapters/openai-compatible";
import { openrouterAdapter } from "../../../apps/mesh/src/ai-providers/adapters/openrouter";
import type {
  ProviderAdapter,
  MeshProvider,
} from "../../../apps/mesh/src/ai-providers/types";

/** Registry of provider adapters available on the daemon. */
const DAEMON_ADAPTERS: Record<string, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  google: googleAdapter,
  "openai-compatible": openaiCompatibleAdapter,
  openrouter: openrouterAdapter,
};

/**
 * Build a HarnessContext-compatible aiProviders shim.
 *
 * The `credentialId` parameter passed by the desktop factory is actually the
 * raw API key (not a DB id) — the factory passes `mcp.modelSecret.apiKey`
 * as the first argument to match the `activate(credentialId, orgId)` signature
 * without needing a DB lookup. This adapter interprets that first argument as
 * the raw key and uses the stored `providerId` from mcp.modelSecret to route.
 *
 * For `openai-compatible`, the apiKey may be a JSON blob `{ baseUrl, apiKey }` —
 * this is already unpacked by the cluster's modelSecret injection in dispatch-run.ts,
 * so by the time it reaches here it is always a plain string key.
 *
 * Call `createDaemonAiProviders(providerId)` ONCE per run; the returned
 * object satisfies `HarnessContext["aiProviders"]`.
 */
export function createDaemonAiProviders(providerId: string): {
  activate(
    apiKey: string,
    _organizationId: string,
  ): Promise<MeshProvider | null>;
} {
  return {
    async activate(
      apiKey: string,
      _organizationId: string,
    ): Promise<MeshProvider | null> {
      const adapter = DAEMON_ADAPTERS[providerId];
      if (!adapter) {
        console.error(
          `[daemon:aiProviders] no adapter for providerId: ${providerId}`,
        );
        return null;
      }
      try {
        return adapter.create(apiKey);
      } catch (err) {
        console.error(`[daemon:aiProviders] failed to create provider:`, err);
        return null;
      }
    },
  };
}
