import { OrgSecretsPage } from "@/web/views/settings/secrets";
import { RequireCapability } from "@/web/components/require-capability";

export default function SecretsRoute() {
  return (
    <RequireCapability capability="secrets:manage" area="secrets">
      <OrgSecretsPage />
    </RequireCapability>
  );
}
