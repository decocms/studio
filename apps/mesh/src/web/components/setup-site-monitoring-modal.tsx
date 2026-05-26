/**
 * Setup Site Monitoring Modal
 *
 * Final step of the Storefront Manager checklist. Asks the user for the
 * storefront's live site URL, writes it to
 * `metadata.storefront.siteUrl` on the chosen storefront's virtual MCP,
 * and ensures a Site Diagnostics agent exists in the org so the
 * Storefront Manager can subtask it at runtime.
 *
 * The Site Diagnostics install mirrors the logic in
 * `SiteDiagnosticsRecruitModal` — registry fetch → create HTTP
 * connection (idempotent on app_id) → create virtual MCP with
 * `metadata.type = "site-diagnostics"`.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  WELL_KNOWN_AGENT_TEMPLATES,
  useConnectionActions,
  useMCPClient,
  useMCPToolCallMutation,
  useProjectContext,
  useVirtualMCPActions,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import type { ConnectionEntity, VirtualMCPEntity } from "@decocms/mesh-sdk";
import type { CollectionListOutput } from "@decocms/bindings/collections";
import { toast } from "sonner";
import { useRegistryApp } from "@/web/hooks/use-registry-app";
import { invalidateVirtualMcpQueries } from "@/web/lib/query-keys";

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    );
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function getStorefronts(allAgents: VirtualMCPEntity[]): VirtualMCPEntity[] {
  return allAgents.filter(
    (vm) =>
      (vm.metadata as { type?: unknown } | null | undefined)?.type ===
      "storefront-manager",
  );
}

function findExistingSiteDiagnostics(
  allAgents: VirtualMCPEntity[],
): VirtualMCPEntity | null {
  return (
    allAgents.find(
      (vm) =>
        (vm.metadata as { type?: unknown } | null | undefined)?.type ===
        "site-diagnostics",
    ) ?? null
  );
}

const SITE_DIAGNOSTICS_TEMPLATE_ID = "site-diagnostics";

export function SetupSiteMonitoringModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const allAgents = useVirtualMCPs();
  const storefronts = getStorefronts(allAgents);
  const existingDiagnostics = findExistingSiteDiagnostics(allAgents);

  const [selectedStorefrontId, setSelectedStorefrontId] = useState<
    string | null
  >(null);
  const [siteUrl, setSiteUrl] = useState("");

  const effectiveStorefrontId =
    storefronts.length === 1
      ? (storefronts[0]?.id ?? null)
      : selectedStorefrontId;

  const handleClose = () => {
    setSelectedStorefrontId(null);
    setSiteUrl("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-[480px] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
          <DialogTitle className="text-base font-semibold">
            Set up site monitoring
          </DialogTitle>
        </DialogHeader>
        {storefronts.length === 0 ? (
          <EmptyState onClose={handleClose} />
        ) : (
          <SetupForm
            storefronts={storefronts}
            effectiveStorefrontId={effectiveStorefrontId}
            onSelectStorefront={setSelectedStorefrontId}
            siteUrl={siteUrl}
            onSiteUrlChange={setSiteUrl}
            existingDiagnostics={existingDiagnostics}
            onComplete={handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <p className="text-sm text-muted-foreground">
        You don't have any storefronts yet. Add a storefront first — the "Add a
        storefront" checklist item walks you through it.
      </p>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function SetupForm({
  storefronts,
  effectiveStorefrontId,
  onSelectStorefront,
  siteUrl,
  onSiteUrlChange,
  existingDiagnostics,
  onComplete,
}: {
  storefronts: VirtualMCPEntity[];
  effectiveStorefrontId: string | null;
  onSelectStorefront: (id: string) => void;
  siteUrl: string;
  onSiteUrlChange: (next: string) => void;
  existingDiagnostics: VirtualMCPEntity | null;
  onComplete: () => void;
}) {
  const setup = useSiteMonitoringSetup({
    existingDiagnostics,
    onComplete,
  });
  const normalized = normalizeUrl(siteUrl);
  const canSubmit =
    normalized !== null && effectiveStorefrontId !== null && !setup.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!normalized || !effectiveStorefrontId) return;
        setup.mutate({
          storefrontId: effectiveStorefrontId,
          siteUrl: normalized,
        });
      }}
      className="flex flex-col gap-5 px-5 pb-5"
    >
      {storefronts.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="storefront-select"
            className="text-xs font-medium text-foreground"
          >
            Which storefront?
          </label>
          <select
            id="storefront-select"
            value={effectiveStorefrontId ?? ""}
            onChange={(e) => onSelectStorefront(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="" disabled>
              Select a storefront
            </option>
            {storefronts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="site-url"
          className="text-xs font-medium text-foreground"
        >
          Live site URL
        </label>
        <Input
          id="site-url"
          type="url"
          placeholder="https://example.com"
          value={siteUrl}
          onChange={(e) => onSiteUrlChange(e.target.value)}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          The Storefront Manager will hand this URL to Site Diagnostics when
          investigating performance, SEO, or broken-link issues.
        </p>
      </div>

      {!existingDiagnostics && (
        <p className="text-xs text-muted-foreground">
          We'll also install the Site Diagnostics agent so Storefront Manager
          can subtask it.
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {setup.isPending ? "Setting up..." : "Save"}
        </Button>
      </div>
    </form>
  );
}

function useSiteMonitoringSetup({
  existingDiagnostics,
  onComplete,
}: {
  existingDiagnostics: VirtualMCPEntity | null;
  onComplete: () => void;
}) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const virtualMcpActions = useVirtualMCPActions();
  const connectionActions = useConnectionActions();
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const connectionQuery = useMCPToolCallMutation({ client: selfClient });

  const template = WELL_KNOWN_AGENT_TEMPLATES.find(
    (t) => t.id === SITE_DIAGNOSTICS_TEMPLATE_ID,
  );
  const appId = template && "appId" in template ? template.appId : undefined;
  const { data: registryItem } = useRegistryApp(appId ?? "", {
    enabled: !existingDiagnostics && Boolean(appId),
  });

  return useMutation({
    mutationFn: async ({
      storefrontId,
      siteUrl,
    }: {
      storefrontId: string;
      siteUrl: string;
    }) => {
      // 1. Persist the site URL on the storefront. Shallow-merge happens
      //    server-side inside COLLECTION_VIRTUAL_MCP_UPDATE — other
      //    metadata keys (instructions, githubRepo, type) are preserved.
      //    Going through selfClient.callTool directly because the typed
      //    mutation requires the full VirtualMCPEntity metadata shape,
      //    which collides with partial-key updates like this one.
      await selfClient.callTool({
        name: "COLLECTION_VIRTUAL_MCP_UPDATE",
        arguments: {
          id: storefrontId,
          data: { metadata: { storefront: { siteUrl } } },
        },
      });

      // 2. If a Site Diagnostics agent is already in the org, we're done.
      if (existingDiagnostics) return { installedDiagnostics: false };

      if (!template || !appId || !registryItem) {
        throw new Error("Site Diagnostics registry data not available yet.");
      }

      const appTitle =
        registryItem.title ||
        registryItem.server?.title ||
        registryItem.server?.name ||
        template.title;
      const appIcon = registryItem.server?.icons?.[0]?.src ?? template.icon;
      const appDescription = registryItem.server?.description ?? null;

      // 3. Find or create the HTTP connection.
      const existingConnRes = await connectionQuery.mutateAsync({
        name: "COLLECTION_CONNECTIONS_LIST",
        arguments: {
          where: { field: ["app_id"], operator: "eq", value: appId },
          limit: 1,
          offset: 0,
        },
      });
      const existingItems = (
        existingConnRes as {
          structuredContent?: CollectionListOutput<ConnectionEntity>;
        }
      )?.structuredContent?.items;
      const matching = existingItems?.find((c) => c.app_id === appId);

      let connectionId: string;
      if (matching) {
        connectionId = matching.id;
      } else {
        const remoteUrl = registryItem.server?.remotes?.[0]?.url;
        if (!remoteUrl) {
          throw new Error(
            "Registry item is missing a remote URL for site-diagnostics",
          );
        }
        const connection = await connectionActions.create.mutateAsync({
          title: appTitle,
          description: appDescription,
          icon: appIcon,
          connection_type: "HTTP",
          connection_url: remoteUrl,
          app_name: registryItem.server?.name ?? "site-diagnostics",
          app_id: appId,
          metadata: {
            type: SITE_DIAGNOSTICS_TEMPLATE_ID,
            source: "store",
            registry_item_id: appId,
            verified: true,
          },
        });
        connectionId = connection.id;
      }

      // 4. Create the Site Diagnostics virtual MCP.
      await virtualMcpActions.create.mutateAsync({
        title: appTitle,
        description: appDescription,
        icon: appIcon,
        status: "active",
        connections: [
          {
            connection_id: connectionId,
            selected_tools: null,
            selected_resources: null,
            selected_prompts: null,
          },
        ],
        metadata: {
          type: SITE_DIAGNOSTICS_TEMPLATE_ID,
          instructions: null,
          ui: {
            pinnedViews: [
              {
                connectionId,
                toolName: "diagnose",
                label: "diagnose",
                icon: null,
              },
            ],
            layout: {
              defaultMainView: {
                type: "ext-apps",
                id: connectionId,
                toolName: "diagnose",
              },
            },
          },
        },
      });

      return { installedDiagnostics: true };
    },
    onSuccess: ({ installedDiagnostics }) => {
      invalidateVirtualMcpQueries(queryClient, org.id);
      toast.success(
        installedDiagnostics
          ? "Site URL saved and Site Diagnostics installed."
          : "Site URL saved.",
      );
      onComplete();
    },
    onError: (error) => {
      toast.error(
        "Failed to set up site monitoring: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
  });
}
