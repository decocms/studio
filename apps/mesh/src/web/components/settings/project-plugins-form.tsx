import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useProjectContext,
  useMCPClient,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { toast } from "sonner";
import { Container } from "@untitledui/icons";
import { sourcePlugins } from "@/web/plugins";
import { pluginSidebarGroups } from "@/web/index";
import type { AnyClientPlugin } from "@decocms/bindings/plugins";
import { BindingSelector } from "@/web/components/binding-selector";

type ProjectUpdateOutput = {
  project: {
    id: string;
    organizationId: string;
    slug: string;
    name: string;
    description: string | null;
    enabledPlugins: string[] | null;
  } | null;
};

type PluginConfigOutput = {
  config: {
    id: string;
    projectId: string;
    pluginId: string;
    connectionId: string | null;
    settings: Record<string, unknown> | null;
  } | null;
};

type ToolTextResponse = { type?: string; text?: string };
type ToolErrorEnvelope = {
  isError?: boolean;
  content?: Array<ToolTextResponse>;
};

const isToolTextError = (payload: unknown): payload is ToolTextResponse => {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as ToolTextResponse;
  return (
    candidate.type === "text" &&
    typeof candidate.text === "string" &&
    candidate.text.trim().toLowerCase().startsWith("error")
  );
};

const unwrapToolResult = <T,>(result: unknown): T => {
  const payload =
    (result as { structuredContent?: unknown }).structuredContent ?? result;
  const maybeErrorEnvelope =
    payload && typeof payload === "object"
      ? (payload as ToolErrorEnvelope)
      : null;
  const contentText =
    maybeErrorEnvelope?.content?.[0]?.text &&
    typeof maybeErrorEnvelope.content[0].text === "string"
      ? maybeErrorEnvelope.content[0].text
      : null;
  if (maybeErrorEnvelope?.isError) {
    throw new Error(contentText ?? "Tool call failed");
  }
  if (isToolTextError(payload)) {
    throw new Error(payload.text);
  }
  return payload as T;
};

// A plugin requires MCP binding if it has a `binding` property or `requiresMcpBinding: true`
function pluginRequiresMcpBinding(plugin: AnyClientPlugin): boolean {
  if (
    (plugin as AnyClientPlugin & { requiresMcpBinding?: boolean })
      .requiresMcpBinding === true
  ) {
    return true;
  }
  return plugin.binding !== undefined;
}

type PendingBindings = Record<string, string | null>;

type PluginRowProps = {
  plugin: AnyClientPlugin;
  isEnabled: boolean;
  isSaving: boolean;
  pendingBinding: string | null | undefined;
  description: string | null;
  label: string;
  icon?: ReactNode;
  projectId: string | undefined;
  client: ReturnType<typeof useMCPClient>;
  onBindingChange: (
    pluginId: string,
    value: string | null,
    serverValue: string | null,
  ) => void;
  onToggle: (pluginId: string, enabled: boolean) => void;
};

function PluginRow({
  plugin,
  isEnabled,
  isSaving,
  pendingBinding,
  description,
  label,
  icon,
  projectId,
  client,
  onBindingChange,
  onToggle,
}: PluginRowProps) {
  const needsBinding = pluginRequiresMcpBinding(plugin);

  const { data: configData, isLoading: isConfigLoading } = useQuery({
    queryKey: KEYS.projectPluginConfig(projectId ?? "", plugin.id),
    queryFn: async () => {
      if (!projectId) {
        throw new Error("Project ID is required to load plugin config.");
      }
      const result = await client.callTool({
        name: "PROJECT_PLUGIN_CONFIG_GET",
        arguments: {
          projectId,
          pluginId: plugin.id,
        },
      });
      return unwrapToolResult<PluginConfigOutput>(result);
    },
    enabled: !!projectId && needsBinding,
  });

  const serverConnectionId = configData?.config?.connectionId ?? null;
  const selectorValue =
    pendingBinding !== undefined ? pendingBinding : serverConnectionId;

  return (
    <div
      className="flex flex-col border-b border-border last:border-0"
      onClick={() => !isSaving && onToggle(plugin.id, !isEnabled)}
      style={{ cursor: isSaving ? undefined : "pointer" }}
    >
      <div className="flex items-center justify-between gap-6 py-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {icon && (
            <span className="text-muted-foreground mt-0.5 shrink-0 [&>svg]:size-4">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{label}</p>
            {description && (
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {description}
              </p>
            )}
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          <Switch
            checked={isEnabled}
            onCheckedChange={(checked) => onToggle(plugin.id, checked)}
            disabled={isSaving}
          />
        </div>
      </div>

      {isEnabled && needsBinding && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="pb-4 pl-7 flex items-center gap-3"
        >
          <Label className="text-xs text-muted-foreground w-24">
            Connection
          </Label>
          <BindingSelector
            value={selectorValue ?? null}
            onValueChange={(value) =>
              onBindingChange(plugin.id, value, serverConnectionId)
            }
            binding={plugin.binding}
            placeholder="Select connection..."
            className="w-56"
            disabled={isSaving || isConfigLoading}
          />
        </div>
      )}
    </div>
  );
}

export function ProjectPluginsForm() {
  const { org, project } = useProjectContext();
  const queryClient = useQueryClient();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  // Track only pending changes (pluginId -> intended state)
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>(
    {},
  );
  const [pendingBindings, setPendingBindings] = useState<PendingBindings>({});
  const [isSaving, setIsSaving] = useState(false);

  const serverPlugins = project.enabledPlugins ?? [];

  // Derive whether a plugin is enabled: pending changes override server state
  const isPluginEnabled = (pluginId: string): boolean => {
    const pending = pendingChanges[pluginId];
    if (pending !== undefined) {
      return pending;
    }
    return serverPlugins.includes(pluginId);
  };

  // Compute the full list of enabled plugins for saving
  const getEnabledPluginsList = (): string[] => {
    const result = new Set(serverPlugins);
    for (const [pluginId, enabled] of Object.entries(pendingChanges)) {
      if (enabled) {
        result.add(pluginId);
      } else {
        result.delete(pluginId);
      }
    }
    return Array.from(result);
  };

  // Check if there are unsaved changes
  const hasChanges =
    Object.keys(pendingChanges).length > 0 ||
    Object.keys(pendingBindings).length > 0;

  const handleTogglePlugin = (pluginId: string, enabled: boolean) => {
    const serverEnabled = serverPlugins.includes(pluginId);

    if (enabled === serverEnabled) {
      // User toggled back to server state, remove from pending changes
      setPendingChanges((prev) => {
        const { [pluginId]: _, ...rest } = prev;
        return rest;
      });
    } else {
      // User changed from server state, track as pending change
      setPendingChanges((prev) => ({ ...prev, [pluginId]: enabled }));
    }
  };

  const handleBindingChange = (
    pluginId: string,
    value: string | null,
    serverValue: string | null,
  ) => {
    if (value === serverValue) {
      setPendingBindings((prev) => {
        const { [pluginId]: _, ...rest } = prev;
        return rest;
      });
      return;
    }

    setPendingBindings((prev) => ({ ...prev, [pluginId]: value }));
  };

  const mutation = useMutation({
    mutationFn: async (input: {
      enabledPlugins: string[];
      updatePlugins: boolean;
      bindingUpdates: Array<{ pluginId: string; connectionId: string | null }>;
    }) => {
      const results: Array<unknown> = [];

      if (input.updatePlugins) {
        const result = await client.callTool({
          name: "PROJECT_UPDATE",
          arguments: {
            projectId: project.id,
            enabledPlugins: input.enabledPlugins,
          },
        });
        results.push(unwrapToolResult<ProjectUpdateOutput>(result));
      }

      if (input.bindingUpdates.length > 0) {
        const bindingResults = await Promise.all(
          input.bindingUpdates.map(async ({ pluginId, connectionId }) => {
            const result = await client.callTool({
              name: "PROJECT_PLUGIN_CONFIG_UPDATE",
              arguments: {
                projectId: project.id,
                pluginId,
                connectionId,
              },
            });
            return unwrapToolResult<PluginConfigOutput>(result);
          }),
        );
        results.push(...bindingResults);
      }

      return results;
    },
    onSuccess: (_data, variables) => {
      if (variables.updatePlugins) {
        queryClient.invalidateQueries({
          queryKey: KEYS.project(org.id, project.slug),
        });
        queryClient.invalidateQueries({
          queryKey: KEYS.projects(org.id),
        });
      }

      variables.bindingUpdates.forEach(({ pluginId }) => {
        queryClient.invalidateQueries({
          queryKey: KEYS.projectPluginConfig(project.id ?? "", pluginId),
        });
      });

      setPendingChanges({});
      setPendingBindings({});
      toast.success("Plugins updated successfully");
    },
    onError: (error) => {
      toast.error(
        "Failed to update plugins: " +
          (error instanceof Error ? error.message : "Unknown error"),
      );
    },
    onSettled: () => {
      setIsSaving(false);
    },
  });

  const handleSave = () => {
    setIsSaving(true);
    mutation.mutate({
      enabledPlugins: getEnabledPluginsList(),
      updatePlugins: Object.keys(pendingChanges).length > 0,
      bindingUpdates: Object.entries(pendingBindings).map(
        ([pluginId, connectionId]) => ({
          pluginId,
          connectionId,
        }),
      ),
    });
  };

  const handleCancel = () => {
    setPendingChanges({});
    setPendingBindings({});
  };

  // Get plugin metadata from sidebar groups
  const getPluginMeta = (pluginId: string) => {
    const group = pluginSidebarGroups.find((g) => g.pluginId === pluginId);
    if (!group) return null;
    return { label: group.label, icon: group.items[0]?.icon };
  };

  // Get plugin description from the source plugin
  const getPluginDescription = (pluginId: string) => {
    const plugin = sourcePlugins.find((p) => p.id === pluginId);
    return plugin?.description ?? null;
  };

  if (sourcePlugins.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No plugins available.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col">
        {sourcePlugins.map((plugin) => {
          const meta = getPluginMeta(plugin.id);
          const description = getPluginDescription(plugin.id);
          const isEnabled = isPluginEnabled(plugin.id);

          return (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              isEnabled={isEnabled}
              isSaving={isSaving}
              pendingBinding={pendingBindings[plugin.id]}
              description={description}
              label={meta?.label ?? plugin.id}
              icon={meta?.icon ?? <Container size={14} />}
              projectId={project.id}
              client={client}
              onBindingChange={handleBindingChange}
              onToggle={handleTogglePlugin}
            />
          );
        })}
      </div>

      <div className="flex items-center gap-3 pt-4">
        <Button
          variant="outline"
          onClick={handleCancel}
          disabled={!hasChanges || isSaving}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="min-w-24"
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
