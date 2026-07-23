/**
 * Org switcher — shared building blocks for switching the active organization.
 *
 * Extracted from `account-popover.tsx` so the same list UI backs both the
 * sidebar-footer account popover and the toolbar breadcrumb (see
 * `shell-breadcrumb.tsx`). The org list is fetched lazily inside
 * `OrganizationsPanel`, so mounting a closed switcher costs nothing.
 */
import { type ReactNode, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Check, Plus, SearchMd, XClose } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/web/i18n/use-t.ts";
import {
  authClient,
  invalidateOrganizationListCache,
  useActiveOrganizations,
} from "@/web/lib/auth-client";
import { CreateOrganizationDialog } from "@/web/components/create-organization-dialog";
import {
  type Invitation,
  usePendingInvitations,
} from "@/web/hooks/use-pending-invitations";

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

export function OrgIcon({
  org,
  size = "sm",
}: {
  org: { name: string; logo?: string | null };
  size?: "xs" | "sm";
}) {
  const sizeClass = size === "xs" ? "size-5" : "size-6";
  const textClass = size === "xs" ? "text-[9px]" : "text-xs";

  return (
    <div
      className={cn(
        sizeClass,
        "shrink-0 rounded-md flex items-center justify-center border border-border/50 overflow-hidden",
      )}
      style={org.logo ? undefined : getOrgColorStyle(org.name)}
    >
      {org.logo ? (
        <img src={org.logo} alt="" className="size-full object-cover" />
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
function InvitationRow({
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

function OrganizationsPanel({
  orgParam,
  onSelectOrg,
  onCreateOrg,
}: {
  orgParam?: string;
  onSelectOrg: (slug: string) => void;
  onCreateOrg: () => void;
}) {
  // Fetched here, not in the parent: this panel only mounts inside the open
  // popover/drawer, so the (potentially large) organization.list call is
  // deferred until the switcher is actually opened — it no longer fires on
  // every page load.
  const t = useT();
  const { data: organizations } = useActiveOrganizations();
  const { invitations: pendingInvitations, refetch: refetchInvitations } =
    usePendingInvitations();
  const sortedOrgs = [...(organizations ?? [])].sort((a, b) => {
    if (a.slug === orgParam) return -1;
    if (b.slug === orgParam) return 1;
    return a.name.localeCompare(b.name);
  });

  const [query, setQuery] = useState("");

  const q = query.toLowerCase();
  const filtered = q
    ? sortedOrgs.filter(
        (o) =>
          o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q),
      )
    : sortedOrgs;

  const iconBtnClass =
    "flex items-center justify-center size-7 rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors";

  return (
    <>
      {/* Search is always live and focused on open — start typing to filter. */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50">
        <SearchMd size={16} className="shrink-0 text-muted-foreground/60" />
        <input
          data-org-switcher-search
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && query && setQuery("")}
          placeholder={t("header.orgSwitcher.searchOrganizations")}
          className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <button type="button" onClick={onCreateOrg} className={iconBtnClass}>
          <Plus size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1">
        {/* Pending invitations lead the list — new orgs you can join with one
            click. Hidden while searching (they're not "your" orgs to filter). */}
        {!query &&
          pendingInvitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onChanged={refetchInvitations}
            />
          ))}
        {filtered.length === 0 && (
          <p className="px-3 py-4 text-sm text-muted-foreground/60 text-center">
            {query
              ? t("header.orgSwitcher.noOrganizationsMatch", { query })
              : t("header.orgSwitcher.noOrganizationsAvailable")}
          </p>
        )}
        {filtered.map((org) => (
          <button
            key={org.id}
            type="button"
            onClick={() => onSelectOrg(org.slug)}
            className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left w-full transition-colors",
              org.slug === orgParam
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50",
            )}
          >
            <OrgIcon org={org} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{org.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {org.slug}
              </p>
            </div>
            {org.slug === orgParam && (
              <Check
                size={14}
                className="ml-auto text-muted-foreground shrink-0"
              />
            )}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Self-contained org switcher popover: renders `trigger` and, on open, the
 * organization list. Selecting an org navigates to `/$org`; the "+" affordance
 * opens the create-organization dialog. Used by the toolbar breadcrumb.
 */
export function OrgSwitcherPopover({
  trigger,
  orgParam,
  align = "start",
  side = "bottom",
}: {
  trigger: ReactNode;
  orgParam?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={16}
          className="w-[300px] p-0 flex flex-col max-h-[440px]"
          // Land focus on the search field (not the content wrapper) so typing
          // filters immediately.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement)
              ?.querySelector<HTMLInputElement>("[data-org-switcher-search]")
              ?.focus();
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <OrganizationsPanel
            key={String(open)}
            orgParam={orgParam}
            onSelectOrg={(slug) => {
              setOpen(false);
              navigate({ to: "/$org", params: { org: slug } });
            }}
            onCreateOrg={() => {
              setOpen(false);
              setCreatingOrg(true);
            }}
          />
        </PopoverContent>
      </Popover>
      <CreateOrganizationDialog
        open={creatingOrg}
        onOpenChange={setCreatingOrg}
      />
    </>
  );
}
