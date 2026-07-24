import MembersPage from "@/routes/orgs/members";
import { RequireCapability } from "@/components/require-capability";

export default function MembersRoute() {
  return (
    <RequireCapability capability="members:manage" area="members">
      <MembersPage />
    </RequireCapability>
  );
}
