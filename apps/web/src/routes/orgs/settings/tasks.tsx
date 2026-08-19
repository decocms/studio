import { OrgTasksSettingsPage } from "@/views/settings/jira";
import { RequireCapability } from "@/components/require-capability";

export default function TasksSettingsRoute() {
  return (
    <RequireCapability capability="org:manage" area="settings">
      <OrgTasksSettingsPage />
    </RequireCapability>
  );
}
