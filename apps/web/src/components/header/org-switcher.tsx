/** Org switcher building blocks: the org mark and the invitation row. The
 *  popover itself is gone — `OrgProjectPicker` names org and project together,
 *  so a separate org list had nowhere left to open from. */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { XClose } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { authClient, invalidateOrganizationListCache } from "@/lib/auth-client";
import type { Invitation } from "@/hooks/use-pending-invitations";

function getOrgColorStyle(name: string): {
  backgroundColor: string;
  color: string;
} {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return {
    backgroundColor: `hsl(${h} 55% 70%)`,
    color: `hsl(${h} 55% 20%)`,
  };
}

const ORG_ICON_SIZES = {
  xs: { box: "size-5", text: "text-[9px]" },
  sm: { box: "size-6", text: "text-xs" },
  lg: { box: "size-9", text: "text-sm" },
} as const;

export function OrgIcon({
  org,
  size = "sm",
  rounded = "rounded-md",
}: {
  org: { name: string; logo?: string | null };
  size?: keyof typeof ORG_ICON_SIZES;
  /** The rail wants a rounder mark than the picker's list rows. */
  rounded?: "rounded-md" | "rounded-xl";
}) {
  const { box: sizeClass, text: textClass } = ORG_ICON_SIZES[size];
  /**
   * The logo URL that failed to load, not a boolean.
   *
   * A missing logo already fell back to initials, but a logo that is PRESENT
   * and fails — a dead CDN link, an asset the browser is not allowed to
   * fetch from this origin — left the browser to draw its own broken-image
   * glyph, which is how a rail of real organizations ends up looking like a
   * rail of torn paper. Remembering the URL rather than a flag means an org
   * whose logo is later fixed gets a fresh attempt on its own.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const logo = org.logo && org.logo !== failedSrc ? org.logo : null;

  return (
    <div
      className={cn(
        sizeClass,
        rounded,
        "shrink-0 flex items-center justify-center border border-border/50 overflow-hidden",
      )}
      style={logo ? undefined : getOrgColorStyle(org.name)}
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedSrc(logo)}
        />
      ) : (
        <span className={cn("font-semibold leading-none", textClass)}>
          {org.name.slice(0, 2).toUpperCase()}
        </span>
      )}
    </div>
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
        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs"
          onClick={accept}
          disabled={busy}
        >
          {t("header.orgSwitcher.accept")}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
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
