import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { useUpdateOrganizationSettings } from "@/web/hooks/use-organization-settings";
import { Switch } from "@deco/ui/components/switch.tsx";
import { toast } from "sonner";
import { Container } from "@untitledui/icons";
import { sourcePlugins } from "@/web/plugins";
import { pluginSidebarGroups, pluginSettingsSidebarItems } from "@/web/index";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";

export function ProjectPluginsForm() {
  const { org, project } = useProjectContext();
  const queryClient = useQueryClient();

  const serverPlugins = project.enabledPlugins ?? [];

  const mutation = useUpdateOrganizationSettings();

  const invalidateDependentCaches = () => {
    queryClient.invalidateQueries({
      queryKey: KEYS.project(org.id, project.slug),
    });
    queryClient.invalidateQueries({
      queryKey: KEYS.projects(org.id),
    });
    queryClient.invalidateQueries({
      predicate: (query) => {
        const k = query.queryKey;
        return (
          k[1] === org.id && k[3] === "collection" && k[4] === "VIRTUAL_MCP"
        );
      },
    });
  };

  const handleTogglePlugin = (pluginId: string, enabled: boolean) => {
    const current = new Set(serverPlugins);
    if (enabled) {
      current.add(pluginId);
    } else {
      current.delete(pluginId);
    }
    mutation.mutate(
      { enabled_plugins: Array.from(current) },
      {
        onSuccess: invalidateDependentCaches,
        onError: (error) => {
          toast.error(
            "Failed to update plugin: " +
              (error instanceof Error ? error.message : "Unknown error"),
          );
        },
      },
    );
  };

  // Get plugin metadata from sidebar groups or settings sidebar items
  const getPluginMeta = (pluginId: string) => {
    const group = pluginSidebarGroups.find((g) => g.pluginId === pluginId);
    if (group) return { label: group.label, icon: group.items[0]?.icon };
    const settingsItem = pluginSettingsSidebarItems.find(
      (i) => i.pluginId === pluginId,
    );
    if (settingsItem)
      return { label: settingsItem.label, icon: settingsItem.icon };
    return null;
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
    <SettingsSection>
      <SettingsCard>
        {sourcePlugins.map((plugin) => {
          const meta = getPluginMeta(plugin.id);
          const description = getPluginDescription(plugin.id);
          const isEnabled = serverPlugins.includes(plugin.id);

          return (
            <SettingsCardItem
              key={plugin.id}
              title={meta?.label ?? plugin.id}
              description={description ?? undefined}
              icon={
                <span className="text-muted-foreground [&>svg]:size-4">
                  {meta?.icon ?? <Container size={14} />}
                </span>
              }
              onClick={() =>
                !mutation.isPending && handleTogglePlugin(plugin.id, !isEnabled)
              }
              action={
                <Switch
                  checked={isEnabled}
                  onCheckedChange={(checked) =>
                    handleTogglePlugin(plugin.id, checked)
                  }
                  disabled={mutation.isPending}
                  onClick={(e) => e.stopPropagation()}
                />
              }
            />
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}
