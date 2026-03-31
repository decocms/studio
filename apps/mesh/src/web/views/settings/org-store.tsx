import { Suspense, useState } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertCircle, ChevronRight, Plus, Trash01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
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
import { useRegistrySettings } from "@/web/hooks/use-registry-settings";

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
      toast.success("Private registry added");
      onSuccess(connectionId);
    },
    onError: (err) => {
      toast.error(`Failed to add registry: ${err.message}`);
    },
  });

  return (
    <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Name
        </label>
        <Input
          placeholder="e.g. Acme Corp Registry"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Registry URL
        </label>
        <Input
          placeholder="https://registry.example.com/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Auth Token (optional)
        </label>
        <Input
          type="password"
          placeholder="Bearer token..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
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
    </div>
  );
}

function RegistryCard({
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.currentTarget === e.target && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/30 transition-colors"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {icon ? (
        <img
          src={icon}
          alt={name}
          className="size-8 rounded-md object-contain shrink-0"
        />
      ) : (
        <Avatar
          fallback={name.charAt(0)}
          className="size-8 bg-primary/10 text-primary shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <h3 className="font-medium text-sm truncate">{name}</h3>
        <p className="text-xs text-muted-foreground line-clamp-1">
          {description}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
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
    </div>
  );
}

function OrgStoreContent() {
  const { org } = useProjectContext();
  const registryConnections = useRegistryConnections();
  const connectionActions = useConnectionActions();
  const { registryConfig, isRegistryEnabled, updateRegistryConfig } =
    useRegistrySettings();
  const queryClient = useQueryClient();

  const [showAddForm, setShowAddForm] = useState(false);

  const decoStoreId = WellKnownOrgMCPId.REGISTRY(org.id);
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
    const current = registryConfig ?? { registries: {}, blockedMcps: [] };
    await updateRegistryConfig({
      ...current,
      registries: {
        ...current.registries,
        [connectionId]: { enabled },
      },
    });
  };

  const handleDelete = async (connectionId: string) => {
    await connectionActions.delete.mutateAsync(connectionId);
    queryClient.invalidateQueries({ queryKey: KEYS.registryConfig(org.id) });
  };

  const handleAddSuccess = async (connectionId: string) => {
    setShowAddForm(false);
    const current = registryConfig ?? { registries: {}, blockedMcps: [] };
    await updateRegistryConfig({
      ...current,
      registries: {
        ...current.registries,
        [connectionId]: { enabled: true },
      },
    });
  };

  return (
    <div className="space-y-6">
      {/* Deco Store */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          Deco Store
        </h3>
        {decoStoreConnection ? (
          <RegistryCard
            name="Deco Store"
            description="Official deco MCP registry with curated integrations"
            icon={decoStoreConnection.icon}
            enabled={isRegistryEnabled(decoStoreId)}
            onToggle={(enabled) => handleToggle(decoStoreId, enabled)}
          />
        ) : (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              Deco Store connection not found. It will be created automatically.
            </p>
          </Card>
        )}
      </div>

      {/* Private Registries */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          Private Registries
        </h3>
        <RegistryCard
          name="Private Registry"
          description="Your organization's private MCP registry"
          enabled={isRegistryEnabled("self")}
          onToggle={(enabled) => handleToggle("self", enabled)}
          href="/$org/settings/store/registry"
        />
        {privateRegistries.map((registry) => (
          <RegistryCard
            key={registry.id}
            name={registry.title}
            description={registry.description ?? "Private MCP registry"}
            icon={registry.icon}
            enabled={isRegistryEnabled(registry.id)}
            onToggle={(enabled) => handleToggle(registry.id, enabled)}
            onDelete={() => handleDelete(registry.id)}
          />
        ))}
        {showAddForm ? (
          <AddPrivateRegistryForm
            onCancel={() => setShowAddForm(false)}
            onSuccess={handleAddSuccess}
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setShowAddForm(true)}
          >
            <Plus size={14} />
            Add Private Registry
          </Button>
        )}
      </div>

      {/* Community Registry */}
      <div className="space-y-3 pt-4 border-t">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Community
        </h3>
        {communityConnection ? (
          <RegistryCard
            name="MCP Registry"
            description="Community MCP registry with thousands of handy MCPs"
            icon={communityConnection.icon}
            enabled={isRegistryEnabled(effectiveCommunityId)}
            onToggle={(enabled) => handleToggle(effectiveCommunityId, enabled)}
          />
        ) : (
          <div className="flex items-center gap-3 p-3 rounded-md bg-muted/30">
            <Avatar
              fallback="M"
              className="size-8 bg-primary/10 text-primary shrink-0"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">MCP Registry</p>
              <p className="text-xs text-muted-foreground">
                Community MCP registry — not yet added
              </p>
            </div>
            <Switch checked={false} disabled onCheckedChange={() => {}} />
          </div>
        )}
      </div>
    </div>
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
              <div className="flex flex-col gap-6">
                <div>
                  <Page.Title>Store</Page.Title>
                </div>
                <OrgStoreContent />
              </div>
            </Page.Body>
          </Page.Content>
        </Page>
      </Suspense>
    </ErrorBoundary>
  );
}
