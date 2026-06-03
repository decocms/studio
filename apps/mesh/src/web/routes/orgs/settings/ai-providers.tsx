import { OrgAiProvidersPage } from "@/web/views/settings/ai-providers";
import { RequireCapability } from "@/web/components/require-capability";

export default function AiProvidersRoute() {
  return (
    <RequireCapability capability="ai-providers:manage" area="AI providers">
      <OrgAiProvidersPage />
    </RequireCapability>
  );
}
