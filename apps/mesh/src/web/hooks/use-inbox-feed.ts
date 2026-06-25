import {
  type PendingJoinRequest,
  usePendingJoinRequests,
} from "@/web/hooks/use-join-requests";
import {
  type Invitation,
  usePendingInvitations,
} from "@/web/hooks/use-pending-invitations";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import { type Release, RELEASES } from "@/web/lib/release-feed";

export type InboxFeedItem =
  | { type: "release"; release: Release; isSeen: boolean }
  | { type: "invitation"; invitation: Invitation }
  | { type: "join-request"; request: PendingJoinRequest };

export interface InboxFeed {
  items: InboxFeedItem[];
  pendingInvitations: Invitation[];
  redDotCount: number;
  markReleaseSeen: (id: string) => void;
}

export function useInboxFeed(): InboxFeed {
  const { isSeen, markSeen, unseenCount } = useReleaseSeenState();
  const pendingInvitations = usePendingInvitations();
  const pendingJoinRequests = usePendingJoinRequests();

  // Join requests need an admin decision, so they pin to the very top (oldest
  // first), then invitations (soonest expiry first), then releases (newest
  // first).
  const joinRequests = [...pendingJoinRequests]
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    .map<InboxFeedItem>((request) => ({ type: "join-request", request }));

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
    items: [...joinRequests, ...invitations, ...releases],
    pendingInvitations,
    redDotCount:
      unseenCount + pendingInvitations.length + pendingJoinRequests.length,
    markReleaseSeen: markSeen,
  };
}
