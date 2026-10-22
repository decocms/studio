/** Org switcher building blocks: the org mark and the invitation row. The
 *  popover itself is gone — `OrgProjectPicker` names org and project together,
 *  so a separate org list had nowhere left to open from. */
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { XClose } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { authClient, invalidateOrganizationListCache } from "@/lib/auth-client";
import type { Invitation } from "@/hooks/use-pending-invitations";

const ORG_ICON_SIZES = { xs: "xs", sm: "xs", lg: "md" } as const;

/** An org's logo, or its initials on its colour: the DS avatar, square. */
export function OrgIcon({
  org,
  size = "sm",
}: {
  org: { name: string; logo?: string | null };
  size?: keyof typeof ORG_ICON_SIZES;
}) {
  return (
    <Avatar
      url={org.logo ?? undefined}
      fallback={org.name}
      size={ORG_ICON_SIZES[size]}
      tone="solid"
    />
  );
}

/**
 * A pending cross-org invitation, rendered as a row in the switcher right
 * alongside the orgs you already belong to — accepting joins the org and
 * navigates there. This is where invitations live now (the old global "inbox"
 * was removed); org-admin join-requests still live in Settings.
 */
/** An invitation you can accept or decline, wherever organizations are
 *  listed. Exported so the sidebar picker shows the same row the switcher
 *  does — an invitation is only actionable where you'd look for the org. */
export function InvitationRow({
  invitation,
  onChanged,
}: {
  invitation: Invitation;
  /** Refresh the invitation list after a decline so the row + breadcrumb dot
   *  clear. Accept hard-navigates, so it doesn't need this. */
  onChanged: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const name =
    invitation.organizationName ?? t("header.orgSwitcher.unknownOrganization");

  const accept = async () => {
    setBusy(true);
    try {
      const res = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });
      if (res.error) {
        toast.error(res.error.message);
        setBusy(false);
        return;
      }
    } catch {
      toast.error(t("header.orgSwitcher.failedToAcceptInvitation"));
      setBusy(false);
      return;
    }
    toast.success(t("header.orgSwitcher.joined", { name }));
    // Membership changed — drop the cached org list, then navigate into the
    // newly joined org (hard nav so the org-scoped loaders re-run cleanly).
    invalidateOrganizationListCache();
    let slug: string | undefined;
    try {
      const org = await authClient.organization.getFullOrganization({
        query: { organizationId: invitation.organizationId },
      });
      slug = org?.data?.slug;
    } catch {
      // fall through to root
    }
    window.location.href = slug ? `/${slug}` : "/";
  };

  const decline = async () => {
    setBusy(true);
    try {
      const res = await authClient.organization.rejectInvitation({
        invitationId: invitation.id,
      });
      if (res.error) {
        toast.error(res.error.message);
        setBusy(false);
        return;
      }
      toast.success(t("header.orgSwitcher.invitationDeclined"));
      // Re-enable in case the refetch keeps the row briefly, and refresh the
      // invitation list so the declined row (and the breadcrumb dot) clear.
      setBusy(false);
      onChanged();
    } catch {
      toast.error(t("header.orgSwitcher.failedToDeclineInvitation"));
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-2.5">
      <OrgIcon org={{ name }} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t("header.orgSwitcher.invitedToJoin")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="default" onClick={accept} disabled={busy}>
          {t("header.orgSwitcher.accept")}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={decline}
          disabled={busy}
          aria-label={t("header.orgSwitcher.declineInvitationTo", { name })}
        >
          <XClose size={14} />
        </Button>
      </div>
    </div>
  );
}
