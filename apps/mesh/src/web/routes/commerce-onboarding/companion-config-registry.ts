import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FC } from "react";
import { matchVerifiedSite, parseListSites } from "./companion-config-core.ts";
import { unwrapToolResult } from "./companions-core.ts";
import { GoogleAnalyticsRenderer } from "./config-renderers/google-analytics.tsx";
import { GoogleSearchConsoleRenderer } from "./config-renderers/google-search-console.tsx";
import type { CompanionConfigRendererProps } from "./config-renderers/types.ts";
import { VtexRenderer } from "./config-renderers/vtex.tsx";

export interface CompanionConfigContext {
  /** Onboarding site host (from CommerceSiteHostContext), for GSC matching. */
  siteHost: string | null;
  /** Downstream connection id being configured. */
  connectionId: string;
  orgId: string;
  orgSlug: string;
}

export interface CompanionConfigEntry {
  bindingType: string;
  /** Downstream config_state key whose presence means "configured". */
  anchorField: string;
  /**
   * Optional: run once for a connected+unconfigured card to compute a patch to
   * auto-save. May call the downstream MCP via `client`. Returns null to skip.
   */
  autoResolve?: (args: {
    client: Client;
    ctx: CompanionConfigContext;
  }) => Promise<Record<string, unknown> | null>;
  Renderer: FC<CompanionConfigRendererProps>;
}

const COMPANION_CONFIG: Record<string, CompanionConfigEntry> = {
  "google-analytics": {
    bindingType: "google-analytics",
    anchorField: "propertyId",
    Renderer: GoogleAnalyticsRenderer,
  },
  "google-search-console": {
    bindingType: "google-search-console",
    anchorField: "siteUrl",
    autoResolve: async ({ client, ctx }) => {
      const result = await client.callTool({
        name: "list_sites",
        arguments: {},
      });
      const { sites } = unwrapToolResult<{ sites?: unknown }>(result);
      const match = matchVerifiedSite(ctx.siteHost, parseListSites({ sites }));
      return match ? { siteUrl: match } : null;
    },
    Renderer: GoogleSearchConsoleRenderer,
  },
  vtex: {
    bindingType: "vtex",
    anchorField: "accountName",
    Renderer: VtexRenderer,
  },
};

export function getCompanionConfig(
  bindingType: string,
): CompanionConfigEntry | undefined {
  return COMPANION_CONFIG[bindingType];
}
