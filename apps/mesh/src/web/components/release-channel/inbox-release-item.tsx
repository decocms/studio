import { ReleaseCard } from "@/web/components/release-channel/release-card";
import type { Release } from "@/web/lib/release-feed";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";

export interface InboxReleaseItemProps {
  release: Release;
  isSeen: boolean;
}

export function InboxReleaseItem({ release, isSeen }: InboxReleaseItemProps) {
  const { markSeen } = useReleaseSeenState();

  return (
    <div className="relative px-5 py-4 border-b border-border last:border-0">
      {!isSeen && (
        <span
          aria-label="New release"
          className="absolute left-2 top-6 size-1.5 rounded-full bg-primary"
        />
      )}
      <ReleaseCard
        release={release}
        onCtaClick={() => markSeen(release.id)}
        onLearnMoreClick={() => markSeen(release.id)}
      />
    </div>
  );
}
