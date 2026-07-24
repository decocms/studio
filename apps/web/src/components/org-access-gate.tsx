import { AutoDomainJoinScreen } from "@/components/auto-domain-join-screen";
import { NoAccessScreen } from "@/components/no-access-screen";
import { PendingInviteScreen } from "@/components/pending-invite-screen";
import { RequestPendingScreen } from "@/components/request-pending-screen";
import { RequestToJoinScreen } from "@/components/request-to-join-screen";
import { useOrgAccessStatus } from "@/hooks/use-org-access-status";
import { clearLastLocation, readLastLocation } from "@/lib/last-location";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

/**
 * Renders the right "you can't enter here yet" screen when the shell layout's
 * activeOrg fetch comes back null. Hits /api/auth/custom/org-access-status to
 * differentiate no-access / pending-invite / auto-domain-join / can-request /
 * request-pending / not-found.
 */
export function OrgAccessGate({ orgSlug }: { orgSlug: string }) {
  const { data } = useOrgAccessStatus(orgSlug);

  // We render only when the user is NOT a member. orgLayout's beforeLoad
  // optimistically recorded this slug as the user's last location (before
  // membership was known), so the home loader — and every gate screen's "Go to
  // home" → "/" — would bounce them straight back here. Undo that optimistic
  // write for every non-member status so leaving actually leaves.
  if (data.status !== "member") {
    if (readLastLocation()?.org === orgSlug) clearLastLocation();

    const cachedSlugMatches =
      localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug()) === orgSlug;
    if (cachedSlugMatches) {
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    }

    // not-found / no-access have nothing actionable here. If the user only
    // landed here via the stale cached slug, bounce back to "/" so the loader
    // picks a valid destination instead of dead-ending. A deliberate visit to a
    // bad org (e.g. a shared link) still shows the screen rather than bouncing.
    if (
      cachedSlugMatches &&
      (data.status === "not-found" || data.status === "no-access")
    ) {
      window.location.href = "/";
      return null;
    }
  }

  if (data.status === "not-found") {
    return <NoAccessScreen orgSlug={orgSlug} reason="not-found" />;
  }

  if (data.status === "pending-invite") {
    return (
      <PendingInviteScreen
        invitationId={data.invitation.id}
        orgName={data.organization.name}
        orgSlug={data.organization.slug}
        orgLogo={data.organization.logo}
      />
    );
  }

  if (data.status === "auto-domain-join") {
    return (
      <AutoDomainJoinScreen
        orgName={data.organization.name}
        orgSlug={data.organization.slug}
        orgLogo={data.organization.logo}
        domain={data.organization.domain ?? ""}
      />
    );
  }

  if (data.status === "can-request") {
    return (
      <RequestToJoinScreen
        orgName={data.organization.name}
        orgSlug={data.organization.slug}
        orgLogo={data.organization.logo}
        domain={data.organization.domain ?? ""}
      />
    );
  }

  if (data.status === "request-pending") {
    return (
      <RequestPendingScreen
        orgName={data.organization.name}
        orgLogo={data.organization.logo}
      />
    );
  }

  // "member" shouldn't normally hit this branch (shell would have rendered
  // already), but if it does, send the user to a fresh load so the shell can
  // pick up the membership. Otherwise fall through to no-access.
  if (data.status === "member") {
    window.location.reload();
    return null;
  }

  return (
    <NoAccessScreen
      orgSlug={orgSlug}
      orgName={data.organization.name}
      reason="no-access"
    />
  );
}
