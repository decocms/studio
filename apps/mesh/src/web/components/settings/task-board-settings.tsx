import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  useTaskBoardEnabled,
  useUpdateTaskBoardEnabled,
} from "@/web/hooks/use-organization-settings";

export function TaskBoardSettings() {
  const enabled = useTaskBoardEnabled();
  const { mutate: updateTaskBoardEnabled, isPending } =
    useUpdateTaskBoardEnabled();

  return (
    <SettingsSection
      title="Task board"
      description="A board for tracking org tasks by status, priority, and assignee."
    >
      <SettingsCard>
        <SettingsCardItem
          title="Enable task board"
          description="Adds a Board entry to the sidebar for this organization."
          action={
            <Switch
              checked={enabled}
              disabled={isPending}
              onCheckedChange={(checked) => updateTaskBoardEnabled(checked)}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
