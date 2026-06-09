import { ProjectPluginsPage } from "@/web/views/settings/project-plugins";
import { RequireCapability } from "@/web/components/require-capability";

export default function FeaturesRoute() {
  return (
    <RequireCapability capability="org:manage" area="plugins">
      <ProjectPluginsPage />
    </RequireCapability>
  );
}
