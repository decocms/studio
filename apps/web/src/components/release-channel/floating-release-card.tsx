import { Button } from "@decocms/ui/components/button.tsx";
import { useState } from "react";
import { AnnouncementCard } from "@/components/announcement-card";
import { DownloadAppDialog } from "@/components/download-app-dialog";
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
