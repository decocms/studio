import {
  type Invitation,
  usePendingInvitations,
} from "@/web/hooks/use-pending-invitations";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import { type Release, RELEASES } from "@/web/lib/release-feed";

export type InboxFeedItem =
  | { type: "release"; release: Release; isSeen: boolean }
  | { type: "invitation"; invitation: Invitation };

interface DatedItem {
  date: number;
  item: InboxFeedItem;
}

export interface InboxFeed {
  items: InboxFeedItem[];
  pendingInvitations: Invitation[];
  redDotCount: number;
  markReleaseSeen: (id: string) => void;
}

export function useInboxFeed(): InboxFeed {
  const { isSeen, markSeen, unseenCount } = useReleaseSeenState();
  const pendingInvitations = usePendingInvitations();

  const dated: DatedItem[] = [
    ...RELEASES.map<DatedItem>((release) => ({
      date: new Date(release.date).getTime(),
      item: { type: "release", release, isSeen: isSeen(release.id) },
    })),
    ...pendingInvitations.map<DatedItem>((invitation) => ({
      date: new Date(invitation.expiresAt).getTime(),
      item: { type: "invitation", invitation },
    })),
  ];

  dated.sort((a, b) => b.date - a.date);

  return {
    items: dated.map((d) => d.item),
    pendingInvitations,
    redDotCount: unseenCount + pendingInvitations.length,
    markReleaseSeen: markSeen,
  };
}
