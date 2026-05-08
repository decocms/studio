import { Suspense, useState } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertCircle, ChevronRight, Plus, Trash01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  useProjectContext,
  WellKnownOrgMCPId,
  useConnectionActions,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { Page } from "@/web/components/page";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { useRegistryConnections } from "@/web/hooks/use-registry-connections";
import {
  useRegistryConfig,
  useUpdateRegistryConfig,
} from "@/web/hooks/use-organization-settings";
import { track } from "@/web/lib/posthog-client";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load store settings: {error.message}
      </span>
    </div>
  );
}

function AddPrivateRegistryForm({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void;
  onSuccess: (connectionId: string) => void;
}) {
  const connectionActions = useConnectionActions();

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const { mutate: addRegistry, isPending } = useMutation({
    mutationFn: async () => {
      const created = await connectionActions.create.mutateAsync({
        title: name || "Private Registry",
        description: "Private MCP registry",
        connection_type: "HTTP",
        connection_url: url,
        connection_token: token || null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata: { type: "registry" },
        app_name: null,
        app_id: null,
        icon: null,
      });
      return created.id;
    },
    onSuccess: (connectionId) => {
      track("store_private_registry_added", {
        connection_id: connectionId,
      });
      toast.success("Private registry added");
      onSuccess(connectionId);
    },
    onError: (err) => {
      toast.error(`Failed to add registry: ${err.message}`);
    },
  });

  return (
    <SettingsCard>
      <SettingsCardItem
        title="Name"
        action={
          <Input
            placeholder="e.g. Acme Corp Registry"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-[280px]"
          />
        }
      />
      <SettingsCardItem
        title="Registry URL"
        action={
          <Input
            placeholder="https://registry.example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-[280px]"
          />
        }
      />
      <SettingsCardItem
        title="Auth Token"
        description="Optional"
        action={
          <Input
            type="password"
            placeholder="Bearer token..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-[280px]"
          />
        }
      />
      <div className="px-5 py-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => addRegistry()}
          disabled={!url || isPending}
        >
          {isPending ? "Adding..." : "Add Registry"}
        </Button>
      </div>
    </SettingsCard>
  );
}

function RegistryItem({
  name,
  description,
  icon,
  enabled,
  onToggle,
  onDelete,
  href,
}: {
  name: string;
  description: string;
  icon?: string | null;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete?: () => void;
  href?: string;
}) {
  const navigate = useNavigate();
  const { org } = useParams({ from: "/shell/$org" });

  const handleClick = () => {
    if (href) {
      navigate({ to: href, params: { org } });
    } else {
      onToggle(!enabled);
    }
  };

  return (
    <SettingsCardItem
      title={name}
      description={description}
      onClick={handleClick}
      icon={
        icon ? (
          <img
            src={icon}
            alt={name}
            className="size-8 rounded-md object-contain"
          />
        ) : (
          <Avatar
            fallback={name.charAt(0)}
            className="size-8 bg-primary/10 text-primary"
          />
        )
      }
      action={
        <div className="flex items-center gap-2">
          {onDelete && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Trash01 size={14} />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-2" align="end">
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium">Remove this registry?</p>
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Switch
            checked={enabled}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={(checked) => onToggle(checked)}
          />
          {href && <ChevronRight size={14} className="text-muted-foreground" />}
        </div>
      }
    />
  );
}

function OrgStoreContent() {
  const { org } = useProjectContext();
  const registryConnections = useRegistryConnections();
  const connectionActions = useConnectionActions();
  const registryConfig = useRegistryConfig();
  const { mutateAsync: updateRegistryConfig } = useUpdateRegistryConfig();
  const queryClient = useQueryClient();

  const [showAddForm, setShowAddForm] = useState(false);

  const decoStoreId = WellKnownOrgMCPId.REGISTRY(org.id);
  const isRegistryEnabled = (connectionId: string): boolean => {
    if (!registryConfig) return connectionId === decoStoreId;
    const entry = registryConfig.registries[connectionId];
    if (!entry) return connectionId === decoStoreId;
    return entry.enabled;
  };
  const communityRegistryId = WellKnownOrgMCPId.COMMUNITY_REGISTRY(org.id);

  const decoStoreConnection = registryConnections.find(
    (c) => c.id === decoStoreId,
  );
  const communityConnection = registryConnections.find(
    (c) => c.id === communityRegistryId || c.id === "community-registry",
  );
  const effectiveCommunityId = communityConnection?.id ?? communityRegistryId;

  const selfMcpId = WellKnownOrgMCPId.SELF(org.id);
  const wellKnownIds = new Set([
    decoStoreId,
    communityRegistryId,
    "community-registry",
    selfMcpId,
  ]);
  const privateRegistries = registryConnections.filter(
    (c) => !wellKnownIds.has(c.id),
  );

  const handleToggle = async (connectionId: string, enabled: boolean) => {
    track("store_registry_toggled", { connection_id: connectionId, enabled });
    const current = registryConfig ?? { registries: {}, blockedMcps: [] };
    await updateRegistryConfig({
      ...current,
      registries: { ...current.registries, [connectionId]: { enabled } },
    });
  };

  const handleDelete = async (connectionId: string) => {
    track("store_private_registry_removed", { connection_id: connectionId });
    await connectionActions.delete.mutateAsync(connectionId);
    queryClient.invalidateQueries({
      queryKey: KEYS.organizationSettings(org.id),
    });
  };

  const handleAddSuccess = async (connectionId: string) => {
    setShowAddForm(false);
    const current = registryConfig ?? { registries: {}, blockedMcps: [] };
    await updateRegistryConfig({
      ...current,
      registries: { ...current.registries, [connectionId]: { enabled: true } },
    });
  };

  return (
    <>
      <SettingsSection title="Deco Store">
        <SettingsCard>
          {decoStoreConnection ? (
            <RegistryItem
              name="Deco Store"
              description="Official deco MCP registry with curated integrations"
              icon={decoStoreConnection.icon}
              enabled={isRegistryEnabled(decoStoreId)}
              onToggle={(enabled) => handleToggle(decoStoreId, enabled)}
            />
          ) : (
            <SettingsCardItem
              title="Deco Store"
              description="Connection not found — will be created automatically."
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Private Registries"
        actions={
          !showAddForm ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddForm(true)}
            >
              <Plus size={14} />
              Add registry
            </Button>
          ) : undefined
        }
      >
        {showAddForm && (
          <AddPrivateRegistryForm
            onCancel={() => setShowAddForm(false)}
            onSuccess={handleAddSuccess}
          />
        )}
        <SettingsCard>
          <RegistryItem
            name="Private Registry"
            description="Your organization's private MCP registry"
            enabled={isRegistryEnabled("self")}
            onToggle={(enabled) => handleToggle("self", enabled)}
            href="/$org/settings/store/registry"
          />
          {privateRegistries.map((registry) => (
            <RegistryItem
              key={registry.id}
              name={registry.title}
              description={registry.description ?? "Private MCP registry"}
              icon={registry.icon}
              enabled={isRegistryEnabled(registry.id)}
              onToggle={(enabled) => handleToggle(registry.id, enabled)}
              onDelete={() => handleDelete(registry.id)}
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Community">
        <SettingsCard>
          {communityConnection ? (
            <RegistryItem
              name="MCP Registry"
              description="Community MCP registry with thousands of handy MCPs"
              icon={communityConnection.icon}
              enabled={isRegistryEnabled(effectiveCommunityId)}
              onToggle={(enabled) =>
                handleToggle(effectiveCommunityId, enabled)
              }
            />
          ) : (
            <SettingsCardItem
              title="MCP Registry"
              description="Community MCP registry — not yet added"
              icon={
                <Avatar
                  fallback="M"
                  className="size-8 bg-primary/10 text-primary"
                />
              }
              action={
                <Switch checked={false} disabled onCheckedChange={() => {}} />
              }
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export function OrgStorePage() {
  return (
    <ErrorBoundary
      fallback={({ error }) => (
        <ErrorFallback
          error={error ?? new Error("Failed to load store settings")}
        />
      )}
    >
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <Page>
          <Page.Content>
            <Page.Body>
              <SettingsPage>
                <Page.Title>Store</Page.Title>
                <OrgStoreContent />
              </SettingsPage>
            </Page.Body>
          </Page.Content>
        </Page>
      </Suspense>
    </ErrorBoundary>
  );
}
