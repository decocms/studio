import { OrgChannelsPage } from "@/web/views/settings/channels";
import { RequireCapability } from "@/web/components/require-capability";

export default function ChannelsRoute() {
  return (
    <RequireCapability capability="channels:manage" area="Channels">
      <OrgChannelsPage />
    </RequireCapability>
  );
}
