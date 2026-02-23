import { Page } from "@/web/components/page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { StoreDiscovery } from "@/web/components/store";
import { StoreRegistrySelect } from "@/web/components/store/store-registry-select";
import { StoreRegistryEmptyState } from "@/web/components/store/store-registry-empty-state";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import {
  getWellKnownCommunityRegistryConnection,
  getWellKnownRegistryConnection,
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
  type ConnectionCreateData,
} from "@decocms/mesh-sdk";
import { PLUGIN_ID as PRIVATE_REGISTRY_PLUGIN_ID } from "mesh-plugin-private-registry/shared";
import { AlertTriangle, Loading01, RefreshCw01 } from "@untitledui/icons";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { Suspense } from "react";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Button } from "@deco/ui/components/button.tsx";

/**
 * Error fallback for when a store registry is unreachable or broken.
 * Shows a friendly message instead of crashing the entire Mesh UI.
 */
function StoreErrorFallback({
  error,
  onRetry,
  registryName,
}: {
  error: Error | null;
  onRetry: () => void;
  registryName: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center space-y-4">
      <div className="bg-destructive/10 p-3 rounded-full">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium">Unable to load store</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          The <strong>{registryName}</strong> registry is currently unreachable.
          This may be a temporary issue — try again in a moment.
        </p>
        {error?.message && (
          <p className="text-xs text-muted-foreground/60 font-mono max-w-md mx-auto truncate">
            {error.message}
          </p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw01 className="size-4" />
        Try again
      </Button>
    </div>
  );
}

export default function StorePage() {
  const { org, project } = useProjectContext();
  const allConnections = useConnections();
  const connectionActions = useConnectionActions();

  // Check if we're viewing a child route (server detail)
  const routerState = useRouterState();
  const isViewingServerDetail =
    routerState.location.pathname.includes("/store/") &&
    routerState.location.pathname.split("/").length > 3;

  // Filter to only show registry connections (those with collections)
  const allRegistryConnections = useRegistryConnections(allConnections);

  // The self MCP caches ALL tools (including plugin tools) in its tools column.
  // When the private-registry plugin is disabled, the COLLECTION_REGISTRY_APP_*
  // tools still appear in the cached array, so the self MCP would incorrectly
  // show up as a registry. Filter it out unless the plugin is actually enabled.
  const selfMcpId = WellKnownOrgMCPId.SELF(org.id);
  // When enabledPlugins is null (no explicit config), the server treats all
  // plugins as visible, so we mirror that by not filtering the self MCP.
  const enabledPlugins = project.enabledPlugins;
  const isPrivateRegistryEnabled =
    enabledPlugins === null ||
    enabledPlugins === undefined ||
    enabledPlugins.includes(PRIVATE_REGISTRY_PLUGIN_ID);

  const registryConnections = allRegistryConnections.filter((c) => {
    if (c.id !== selfMcpId) return true;
    return isPrivateRegistryEnabled;
  });

  const hasSelfMcpRegistry = registryConnections.some(
    (c) => c.id === selfMcpId,
  );
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const { data: registryPluginConfig } = useQuery({
    queryKey: KEYS.projectPluginConfig(
      project.id ?? "",
      PRIVATE_REGISTRY_PLUGIN_ID,
    ),
    queryFn: async () => {
      const result = (await selfClient.callTool({
        name: "PROJECT_PLUGIN_CONFIG_GET",
        arguments: {
          projectId: project.id,
          pluginId: PRIVATE_REGISTRY_PLUGIN_ID,
        },
      })) as { structuredContent?: Record<string, unknown> };
      return (result.structuredContent ?? result) as {
        config?: {
          settings?: {
            registryName?: string;
            registryIcon?: string;
            storePrivateOnly?: boolean;
          };
        };
      };
    },
    enabled: hasSelfMcpRegistry && !!project.id,
    staleTime: 60_000,
  });

  const registryBranding = registryPluginConfig?.config?.settings;

  const registryOptions = registryConnections.map((c) => {
    // Override branding for the self MCP when private-registry plugin has custom name/icon
    if (c.id === selfMcpId && registryBranding) {
      return {
        id: c.id,
        name: registryBranding.registryName || c.title,
        icon: registryBranding.registryIcon || c.icon || undefined,
      };
    }
    return {
      id: c.id,
      name: c.title,
      icon: c.icon || undefined,
    };
  });

  // Persist selected registry in localStorage (scoped by org)
  const [selectedRegistryId, setSelectedRegistryId] = useLocalStorage<string>(
    LOCALSTORAGE_KEYS.selectedRegistry(org.slug),
    (existing) => existing ?? "",
  );

  const selectedRegistry = registryConnections.find(
    (c) => c.id === selectedRegistryId,
  );

  // If there's only one registry, use it; otherwise use the selected one if it still exists.
  // If not found, that's fine: the connection may have been deleted/changed.
  const effectiveRegistry =
    selectedRegistry?.id || registryConnections[0]?.id || "";
  const storePrivateOnlyForSelf =
    effectiveRegistry === selfMcpId &&
    registryBranding?.storePrivateOnly === true;

  // Well-known registries to show in select (hidden/less prominent)
  const wellKnownRegistriesForSelect = [getWellKnownRegistryConnection(org.id)];

  // Well-known registries to show in empty state (only Community Registry)
  const wellKnownRegistriesForEmptyState = [
    getWellKnownCommunityRegistryConnection(),
  ];

  const addNewKnownRegistry = async (registry: ConnectionCreateData) => {
    const created = await connectionActions.create.mutateAsync(registry);
    setSelectedRegistryId(created.id);
  };

  // Filter out well-known registries that are already added
  const addedRegistryIds = new Set(registryConnections.map((c) => c.id));
  const availableWellKnownRegistries = wellKnownRegistriesForSelect.filter(
    (r) => r.id && !addedRegistryIds.has(r.id),
  );
  const availableWellKnownRegistriesForEmptyState =
    wellKnownRegistriesForEmptyState.filter(
      (r) => r.id && !addedRegistryIds.has(r.id),
    );

  // If we're viewing a server detail (child route), render the Outlet
  if (isViewingServerDetail) {
    return <Outlet />;
  }

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Store</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
        <Page.Header.Right>
          <StoreRegistrySelect
            wellKnownRegistries={availableWellKnownRegistries}
            registries={registryOptions}
            value={effectiveRegistry}
            onValueChange={setSelectedRegistryId}
            onAddWellKnown={async (registry) => addNewKnownRegistry(registry)}
            placeholder="Select store..."
          />
        </Page.Header.Right>
      </Page.Header>

      {/* Content Section */}
      <Page.Content>
        <ErrorBoundary
          fallback={({ error, resetError }) => (
            <StoreErrorFallback
              error={error}
              onRetry={resetError}
              registryName={
                registryOptions.find((r) => r.id === effectiveRegistry)?.name ??
                "registry"
              }
            />
          )}
        >
          <Suspense
            fallback={
              <div className="flex flex-col items-center justify-center h-full">
                <Loading01
                  size={32}
                  className="animate-spin text-muted-foreground mb-4"
                />
                <p className="text-sm text-muted-foreground">
                  Loading store items...
                </p>
              </div>
            }
          >
            {effectiveRegistry ? (
              <StoreDiscovery
                registryId={effectiveRegistry}
                storePrivateOnly={storePrivateOnlyForSelf}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full">
                <StoreRegistryEmptyState
                  registries={availableWellKnownRegistriesForEmptyState}
                  onConnected={(createdRegistryId) => {
                    // Auto-select the newly created registry
                    setSelectedRegistryId(createdRegistryId);
                  }}
                />
              </div>
            )}
          </Suspense>
        </ErrorBoundary>
      </Page.Content>
    </Page>
  );
}
