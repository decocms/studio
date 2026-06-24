import { AutoDomainJoinScreen } from "@/web/components/auto-domain-join-screen";
import { NoAccessScreen } from "@/web/components/no-access-screen";
import { PendingInviteScreen } from "@/web/components/pending-invite-screen";
import { RequestPendingScreen } from "@/web/components/request-pending-screen";
import { RequestToJoinScreen } from "@/web/components/request-to-join-screen";
import { useOrgAccessStatus } from "@/web/hooks/use-org-access-status";
import { clearLastLocation, readLastLocation } from "@/web/lib/last-location";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

/**
 * Renders the right "you can't enter here yet" screen when the shell layout's
 * activeOrg fetch comes back null. Hits /api/auth/custom/org-access-status to
 * differentiate no-access vs pending-invite vs auto-domain-join vs not-found.
 */
export function OrgAccessGate({ orgSlug }: { orgSlug: string }) {
  const { data } = useOrgAccessStatus(orgSlug);

  if (data.status === "not-found" || data.status === "no-access") {
    // A bad org must never be restored on the next cold entry. orgLayout's
    // beforeLoad records the current org optimistically (before membership is
    // known), so clear it here whether the user arrived deliberately or via a
    // stale restore — otherwise homeRoute would keep bouncing them back here.
    if (readLastLocation()?.org === orgSlug) clearLastLocation();

    // Self-heal the home route's optimistic cached-slug redirect: bounce back
    // to "/" so the loader can pick a valid destination instead of dead-ending.
    // Only for the cached slug — a deliberate visit to a bad org (e.g. a shared
    // link) should show the not-found / no-access screen, not silently bounce.
    if (localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug()) === orgSlug) {
      localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
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
