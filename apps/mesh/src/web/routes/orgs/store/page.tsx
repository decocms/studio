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
import { GitHubRegistryDiscovery } from "@/web/components/store/github-registry-discovery";
import { SkillsShDiscovery } from "@/web/components/store/skills-sh-discovery";
import { GitHubRegistryAddDialog } from "@/web/components/store/github-registry-add-dialog";
import { useRegistryConnections } from "@/web/hooks/use-binding";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { useGitHubRegistries } from "@/web/hooks/use-github-registries";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import {
  getWellKnownCommunityRegistryConnection,
  getWellKnownRegistryConnection,
  ORG_ADMIN_PROJECT_SLUG,
  SELF_MCP_ALIAS_ID,
  useConnectionActions,
  useConnections,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
  type ConnectionCreateData,
} from "@decocms/mesh-sdk";
import { slugify } from "@/web/utils/slugify";
import { PLUGIN_ID as PRIVATE_REGISTRY_PLUGIN_ID } from "mesh-plugin-private-registry/shared";
import { AlertTriangle, Loading01, RefreshCw01 } from "@untitledui/icons";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Button } from "@deco/ui/components/button.tsx";

// GitHub registry IDs are prefixed with "github:" to distinguish from MCP connection IDs
const GITHUB_PREFIX = "github:";
const SKILLSSH_ID = "skillssh:";

function isSkillsShId(id: string): boolean {
  return id === SKILLSSH_ID;
}

function parseGitHubRegistryId(id: string): {
  owner: string;
  repo: string;
} | null {
  if (!id.startsWith(GITHUB_PREFIX)) return null;
  const parts = id.slice(GITHUB_PREFIX.length).split("/");
  if (parts.length !== 2) return null;
  return { owner: parts[0]!, repo: parts[1]! };
}

function makeGitHubRegistryId(owner: string, repo: string): string {
  return `${GITHUB_PREFIX}${owner}/${repo}`;
}

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
  const navigate = useNavigate();
  const githubRegistries = useGitHubRegistries(org.slug);
  const [addRepoOpen, setAddRepoOpen] = useState(false);

  const navigateToGitHubItem = (
    item: import("@/web/components/store/types").RegistryItem,
  ) => {
    const meta = item._meta as
      | Record<string, Record<string, string>>
      | undefined;
    const gh = meta?.["mesh.github"];
    if (!gh) return;
    navigate({
      to: "/$org/$project/store/$appName",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        appName: slugify(item.name || item.title || "item"),
      },
      search: {
        ghOwner: gh.owner,
        ghRepo: gh.repo,
        ghType: gh.type as "skill" | "agent",
        ghName: item.server?.name || gh.path?.split("/").pop() || "",
      },
    });
  };

  const navigateToSkillsShItem = (
    item: import("@/web/components/store/types").RegistryItem,
  ) => {
    const meta = item._meta as
      | Record<string, Record<string, string>>
      | undefined;
    const sh = meta?.["mesh.skillssh"];
    if (!sh) return;
    // For skills.sh items, navigate with the source repo info
    navigate({
      to: "/$org/$project/store/$appName",
      params: {
        org: org.slug,
        project: ORG_ADMIN_PROJECT_SLUG,
        appName: slugify(item.name || item.title || "skill"),
      },
      search: {
        ghOwner: sh.source?.split("/")[0] || "",
        ghRepo: sh.source?.split("/")[1] || "",
        ghType: "skill" as const,
        ghName:
          (meta?.["mesh.skillssh"]?.skillId as string) ||
          item.server?.name ||
          "",
      },
    });
  };

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

  const registryConnections = allRegistryConnections
    .filter((c) => {
      if (c.id !== selfMcpId) return true;
      return isPrivateRegistryEnabled;
    })
    .sort((a, b) => {
      if (a.id === selfMcpId) return 1;
      if (b.id === selfMcpId) return -1;
      return 0;
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

  const mcpRegistryOptions = registryConnections.map((c) => {
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

  // Add GitHub registries and skills.sh to the options
  const githubRegistryOptions = githubRegistries.registries.map((r) => ({
    id: makeGitHubRegistryId(r.owner, r.repo),
    name: `${r.owner}/${r.repo}`,
    icon: undefined,
    isGitHub: true as const,
  }));

  const skillsShOption = {
    id: SKILLSSH_ID,
    name: "skills.sh",
    icon: undefined,
  };

  const registryOptions = [
    ...mcpRegistryOptions,
    ...githubRegistryOptions,
    skillsShOption,
  ];

  // Persist selected registry in localStorage (scoped by org)
  const [selectedRegistryId, setSelectedRegistryId] = useLocalStorage<string>(
    LOCALSTORAGE_KEYS.selectedRegistry(org.slug),
    (existing) => existing ?? "",
  );

  // Check if selected registry is a GitHub or skills.sh registry (not an MCP connection)
  const isSelectedNonMcp =
    selectedRegistryId &&
    (parseGitHubRegistryId(selectedRegistryId) !== null ||
      isSkillsShId(selectedRegistryId));

  const selectedRegistry = isSelectedNonMcp
    ? registryOptions.find((r) => r.id === selectedRegistryId)
    : registryConnections.find((c) => c.id === selectedRegistryId);

  // If there's only one registry, use it; otherwise use the selected one if it still exists.
  // Prefer a non-self registry as default so the Deco Store (or Community Registry)
  // is shown instead of the Mesh MCP when nothing is explicitly selected.
  const firstNonSelfRegistry = registryConnections.find(
    (c) => c.id !== selfMcpId,
  );
  const effectiveRegistry =
    selectedRegistry?.id ||
    firstNonSelfRegistry?.id ||
    registryConnections[0]?.id ||
    "";
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
            onAddGitHubRepo={() => setAddRepoOpen(true)}
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
              (() => {
                const ghParsed = parseGitHubRegistryId(effectiveRegistry);
                if (ghParsed) {
                  return (
                    <GitHubRegistryDiscovery
                      owner={ghParsed.owner}
                      repo={ghParsed.repo}
                      onItemClick={navigateToGitHubItem}
                    />
                  );
                }
                if (isSkillsShId(effectiveRegistry)) {
                  return (
                    <SkillsShDiscovery onItemClick={navigateToSkillsShItem} />
                  );
                }
                return (
                  <StoreDiscovery
                    registryId={effectiveRegistry}
                    storePrivateOnly={storePrivateOnlyForSelf}
                  />
                );
              })()
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

        <GitHubRegistryAddDialog
          open={addRepoOpen}
          onOpenChange={setAddRepoOpen}
          onAdd={(owner, repo) => {
            githubRegistries.addRegistry(owner, repo);
            setSelectedRegistryId(makeGitHubRegistryId(owner, repo));
          }}
        />
      </Page.Content>
    </Page>
  );
}
