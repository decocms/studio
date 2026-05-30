import { Button } from "@deco/ui/components/button.tsx";
import { XClose } from "@untitledui/icons";
import { ReleaseCard } from "@/web/components/release-channel/release-card";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import { RELEASES } from "@/web/lib/release-feed";

const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

export function FloatingReleaseCard() {
  const { isSeen, markSeen } = useReleaseSeenState();
  const candidate = pickFloatingCandidate(Date.now());

  if (!candidate) return null;
  if (isSeen(candidate.id)) return null;

  return (
    <div
      role="dialog"
      aria-label="Release announcement"
      className="fixed bottom-6 right-6 z-50 w-[min(360px,calc(100vw-3rem))] rounded-lg border border-border bg-background p-4 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <Button
        size="icon"
        variant="ghost"
        aria-label="Dismiss release announcement"
        className="absolute right-2 top-2 size-7 text-muted-foreground"
        onClick={() => markSeen(candidate.id)}
      >
        <XClose size={14} />
      </Button>
      <ReleaseCard
        release={candidate}
        onCtaClick={() => markSeen(candidate.id)}
        onLearnMoreClick={() => markSeen(candidate.id)}
      />
    </div>
  );
}
