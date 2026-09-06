import { Button } from "@decocms/ui/components/button.tsx";
import { useState } from "react";
import { AnnouncementCard } from "@/components/announcement-card";
import { DownloadAppDialog } from "@/components/download-app-dialog";
import { startLayoutTour } from "@/components/layout-tour/layout-tour";
import {
  DESTINATION_ROUTE,
  useLeafRoutePath,
} from "@/hooks/use-destination-route";
import { useScopeId } from "@/hooks/use-project-scope";
import { isSurfaceTab } from "@/layouts/main-panel-tabs/source-system-tabs";
import { useActivePanelTabId } from "@/layouts/main-panel-tabs/use-panel-navigate";
import { useReleaseSeenState } from "@/hooks/use-release-seen-state";
import { useT } from "@/i18n/use-t.ts";
import { authClient } from "@/lib/auth-client";
import { RELEASES } from "@/lib/release-feed";

const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_USER_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Parse "YYYY-MM-DD" as local midnight (not UTC) so the card surfaces on the
// listed calendar date everywhere, not after the viewer's clock catches up to
// UTC midnight.
function parseReleaseDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return new Date(date).getTime();
  return new Date(y, m - 1, d).getTime();
}

function pickFloatingCandidate(now: number) {
  const latest = RELEASES[0];
  if (!latest) return null;
  const releaseTime = parseReleaseDate(latest.date);
  const age = now - releaseTime;
  if (age < 0 || age > FRESHNESS_WINDOW_MS) return null;
  return latest;
}

function parseUserCreatedAt(createdAt: unknown): number | null {
  if (createdAt instanceof Date) return createdAt.getTime();
  if (typeof createdAt === "string" || typeof createdAt === "number") {
    const time = new Date(createdAt).getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function isUserOldEnoughForReleaseNotice(createdAt: unknown, now: number) {
  const createdAtTime = parseUserCreatedAt(createdAt);
  if (createdAtTime === null) return false;
  return now - createdAtTime >= MIN_USER_AGE_MS;
}

export function FloatingReleaseCard() {
  const t = useT();
  /** Which surfaces the CURRENT screen has, for the tour's scoped steps. Both
   *  read straight off the URL, so they are right on the first frame and
   *  cannot disagree with what is painted. */
  const scopeId = useScopeId();
  const leafPath = useLeafRoutePath();
  const activeTab = useActivePanelTabId();
  const inProject = !!scopeId;
  const onOrgHome = leafPath === DESTINATION_ROUTE.home && !scopeId;
  /** Preview, Content and Code are the one Site Editor surface, so the tab
   *  bar and branch selector are on screen for all three — the same predicate
   *  the sidebar row uses to stay lit. */
  const onSiteEditor = inProject && !!activeTab && isSurfaceTab(activeTab);
  const { data: session } = authClient.useSession();
  const { isSeen, markSeen } = useReleaseSeenState();
  const [downloadOpen, setDownloadOpen] = useState(false);
  const now = Date.now();
  const candidate = pickFloatingCandidate(now);

  if (!candidate) return null;
  if (!isUserOldEnoughForReleaseNotice(session?.user?.createdAt, now)) {
    return null;
  }
  if (isSeen(candidate.id)) return null;

  /** The tour explains the screen you are ON. It used to navigate to the org
   *  home first, because that was where its only anchors lived; now the steps
   *  are scoped, so the shell steps run anywhere and the route contributes
   *  whatever else it can show. Navigating would throw away whatever the
   *  reader was doing to tell them about a page they did not ask for.
   *
   *  Marking seen unmounts this card, which is fine — `startLayoutTour` is
   *  imperative and owns its own lifecycle from here. */
  const startTour = () => {
    markSeen(candidate.id);
    startLayoutTour(t, { onOrgHome, inProject, onSiteEditor });
  };

  return (
    <AnnouncementCard
      ariaLabel={t("announcements.release.ariaLabel")}
      dismissLabel={t("announcements.release.dismiss")}
      eyebrow={candidate.eyebrow}
      title={candidate.title}
      onDismiss={() => markSeen(candidate.id)}
      footerLeading={
        candidate.learnMoreHref ? (
          <a
            href={candidate.learnMoreHref}
            target="_blank"
            rel="noreferrer"
            onClick={() => markSeen(candidate.id)}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("announcements.release.learnMore")}
          </a>
        ) : null
      }
      actions={
        candidate.cta ? (
          "href" in candidate.cta ? (
            <Button asChild size="sm" onClick={() => markSeen(candidate.id)}>
              <a href={candidate.cta.href}>{candidate.cta.label}</a>
            </Button>
          ) : candidate.cta.action === "start-tour" ? (
            <Button size="sm" onClick={startTour}>
              {candidate.cta.label}
            </Button>
          ) : (
            // Not markSeen here: seeing the release unmounts this card — and
            // the dialog with it. Marked when the dialog closes instead.
            <Button size="sm" onClick={() => setDownloadOpen(true)}>
              {candidate.cta.label}
            </Button>
          )
        ) : null
      }
    >
      <ul className="flex flex-col gap-3">
        {candidate.bullets.map((bullet, idx) => (
          <li key={idx} className="flex items-start gap-3">
            <bullet.icon
              size={20}
              className="mt-0.5 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {bullet.title}
              </p>
              <p className="text-xs text-muted-foreground">{bullet.body}</p>
            </div>
          </li>
        ))}
      </ul>

      <DownloadAppDialog
        open={downloadOpen}
        onOpenChange={(open) => {
          setDownloadOpen(open);
          if (!open) markSeen(candidate.id);
        }}
      />
    </AnnouncementCard>
  );
}
