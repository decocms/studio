import { AutoDomainJoinScreen } from "@/web/components/auto-domain-join-screen";
import { NoAccessScreen } from "@/web/components/no-access-screen";
import { PendingInviteScreen } from "@/web/components/pending-invite-screen";
import { useOrgAccessStatus } from "@/web/hooks/use-org-access-status";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

/**
 * Renders the right "you can't enter here yet" screen when the shell layout's
 * activeOrg fetch comes back null. Hits /api/auth/custom/org-access-status to
 * differentiate no-access vs pending-invite vs auto-domain-join vs not-found.
 */
export function OrgAccessGate({ orgSlug }: { orgSlug: string }) {
  const { data } = useOrgAccessStatus(orgSlug);

  // Self-heal the home route's optimistic redirect: if we sent the user here
  // from a cached slug that turned out to be stale (org deleted or membership
  // lost), clear it and bounce back to "/" so the home loader can pick a valid
  // destination — instead of dead-ending on the not-found / no-access screen.
  if (
    (data.status === "not-found" || data.status === "no-access") &&
    localStorage.getItem(LOCALSTORAGE_KEYS.lastOrgSlug()) === orgSlug
  ) {
    localStorage.removeItem(LOCALSTORAGE_KEYS.lastOrgSlug());
    window.location.href = "/";
    return null;
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
