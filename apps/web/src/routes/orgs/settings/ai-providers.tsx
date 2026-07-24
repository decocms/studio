import { OrgAiProvidersPage } from "@/views/settings/ai-providers";
import { RequireCapability } from "@/components/require-capability";

export default function AiProvidersRoute() {
  return (
    <RequireCapability capability="ai-providers:manage" area="AI providers">
      <OrgAiProvidersPage />
    </RequireCapability>
  );
}
