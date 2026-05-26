import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { RELEASES } from "@/web/lib/release-feed";

const STORAGE_KEY = "studio.release-feed.v1";

type SeenMap = Record<string, { seenAt: string }>;

export interface ReleaseSeenState {
  isSeen: (id: string) => boolean;
  markSeen: (id: string) => void;
  unseenCount: number;
}

export function useReleaseSeenState(): ReleaseSeenState {
  // `useLocalStorage` provides the long-lived cache (so other components and
  // re-mounts stay in sync). We mirror its value into local state for two
  // reasons:
  //  1. Synchronous re-render on `markSeen`, so consumers see the new value on
  //     the very next render (the underlying mutation is async).
  //  2. The local mirror seeds from the initial cache value, which itself
  //     hydrates from localStorage.
  const [seen] = useLocalStorage<SeenMap>(STORAGE_KEY, {});
  const [localSeen, setLocalSeen] = useState<SeenMap>(seen);
  const queryClient = useQueryClient();

  const isSeen = (id: string) => Boolean(localSeen[id]);

  const markSeen = (id: string) => {
    if (localSeen[id]) return;
    const next: SeenMap = {
      ...localSeen,
      [id]: { seenAt: new Date().toISOString() },
    };
    // Write through synchronously: update the localStorage backing store and
    // the TanStack Query cache so other consumers of `useLocalStorage` pick
    // up the new value on their next read.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    queryClient.setQueryData(["localStorage", STORAGE_KEY], next);
    setLocalSeen(next);
  };

  const unseenCount = RELEASES.reduce(
    (count, release) => (localSeen[release.id] ? count : count + 1),
    0,
  );

  return { isSeen, markSeen, unseenCount };
}
