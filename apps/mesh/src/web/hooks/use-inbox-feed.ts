import {
  type Invitation,
  usePendingInvitations,
} from "@/web/hooks/use-pending-invitations";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import { type Release, RELEASES } from "@/web/lib/release-feed";

export type InboxFeedItem =
  | { type: "release"; release: Release; isSeen: boolean }
  | { type: "invitation"; invitation: Invitation };

export interface InboxFeed {
  items: InboxFeedItem[];
  pendingInvitations: Invitation[];
  redDotCount: number;
  markReleaseSeen: (id: string) => void;
}

export function useInboxFeed(): InboxFeed {
  const { isSeen, markSeen, unseenCount } = useReleaseSeenState();
  const pendingInvitations = usePendingInvitations();

  // Invitations are actionable and stay pinned above releases. Within each
  // group, invitations are sorted by soonest expiry (most urgent first) and
  // releases by newest publish date first.
  const invitations = [...pendingInvitations]
    .sort(
      (a, b) =>
        new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime(),
    )
    .map<InboxFeedItem>((invitation) => ({ type: "invitation", invitation }));

  const releases = [...RELEASES]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map<InboxFeedItem>((release) => ({
      type: "release",
      release,
      isSeen: isSeen(release.id),
    }));

  return {
    items: [...invitations, ...releases],
    pendingInvitations,
    redDotCount: unseenCount + pendingInvitations.length,
    markReleaseSeen: markSeen,
  };
}
