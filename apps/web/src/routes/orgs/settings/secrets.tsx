import { OrgSecretsPage } from "@/views/settings/secrets";
import { RequireCapability } from "@/components/require-capability";

export default function SecretsRoute() {
  return (
    <RequireCapability capability="secrets:manage" area="secrets">
      <OrgSecretsPage />
    </RequireCapability>
  );
}
