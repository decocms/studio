import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { Share07 } from "@untitledui/icons";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "@tanstack/react-router";
import { CopyRow, InviteLinkPanel } from "@/components/invite-link-panel";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useCurrentView } from "@/hooks/use-current-view";
import { useCanShareInviteLinks } from "@/hooks/use-invite-links";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useProjectContextOptional } from "@/sdk";

/** Names the link carries, outermost first: project, then the page. An app
 *  page is named after the project tab that shows it, else its tool. */
function useShareLabels(): string[] {
  const { project, title } = useCurrentView();
  const params = useParams({ strict: false });
  const tabs = project?.metadata?.ui?.layout?.tabs ?? [];
  const tab = params.viewId
    ? tabs.find((tab) => tab.id === params.viewId)
    : params.connectionId
      ? tabs.find((tab) => tab.view.appId === params.connectionId)
      : undefined;
  const page =
    tab?.title ??
    (params.toolName
      ? decodeURIComponent(params.toolName).replace(/_/g, " ")
      : title);
  return project?.title ? [project.title, page] : [page];
}

function ShortLinkSection({
  orgId,
  orgSlug,
}: {
  orgId: string;
  orgSlug: string;
}) {
  const t = useT();
  const location = useLocation();
  const labels = useShareLabels();
  const link = useQuery({
    queryKey: KEYS.shortLink(orgId, location.href),
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(
        `/api/${encodeURIComponent(orgSlug)}/short-links`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetPath: location.href, labels }),
        },
      );
      if (!res.ok) throw new Error(`short link: ${res.status}`);
      const { path } = (await res.json()) as { path: string };
      return `${window.location.origin}${path}`;
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">
          {t("common.sharePage.linkTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("common.sharePage.linkDescription")}
        </span>
      </div>
      {link.data ? (
        <CopyRow url={link.data} />
      ) : link.isError ? (
        <span className="text-xs text-destructive">
          {t("common.sharePage.linkFailed")}
        </span>
      ) : (
        <Skeleton className="h-8 w-full" />
      )}
    </div>
  );
}

function SharePagePopover({
  orgId,
  orgSlug,
  orgName,
}: {
  orgId: string;
  orgSlug: string;
  orgName: string;
}) {
  const t = useT();
  const location = useLocation();
  const canInvite = useCanShareInviteLinks();

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <ToolbarIconButton aria-label={t("common.sharePage.button")}>
              <Share07 size={16} />
            </ToolbarIconButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("common.sharePage.button")}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="flex flex-col gap-4">
          <ShortLinkSection orgId={orgId} orgSlug={orgSlug} />
          {canInvite && (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">
                  {t("common.sharePage.title")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("common.sharePage.description", { orgName })}
                </span>
              </div>
              {/* Remount per page so a link made on one page is not shown on another. */}
              <InviteLinkPanel
                key={location.href}
                role="user"
                redirectPath={location.href}
                source="share_button"
              />
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Hands the current page to someone: a short link that reopens it as it is
 * now, and for member managers an invite that also joins them to the org.
 */
export function SharePageButton() {
  const project = useProjectContextOptional();
  if (!project?.org.id) return null;
  return (
    <SharePagePopover
      orgId={project.org.id}
      orgSlug={project.org.slug}
      orgName={project.org.name}
    />
  );
}
