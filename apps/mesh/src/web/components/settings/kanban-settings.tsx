import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  useKanbanEnabled,
  useUpdateKanbanEnabled,
} from "@/web/hooks/use-organization-settings";

export function KanbanSettings() {
  const enabled = useKanbanEnabled();
  const { mutate: updateKanbanEnabled, isPending } = useUpdateKanbanEnabled();

  return (
    <SettingsSection
      title="Kanban board"
      description="A board for tracking org tasks by status, priority, and assignee."
    >
      <SettingsCard>
        <SettingsCardItem
          title="Enable Kanban board"
          description="Adds a Kanban entry to the sidebar for this organization."
          action={
            <Switch
              checked={enabled}
              disabled={isPending}
              onCheckedChange={(checked) => updateKanbanEnabled(checked)}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
