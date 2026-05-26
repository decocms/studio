import { useState } from "react";
import { RELEASES } from "@/web/lib/release-feed";

const STORAGE_KEY = "studio.release-feed.v1";

type SeenMap = Record<string, { seenAt: string }>;

export interface ReleaseSeenState {
  isSeen: (id: string) => boolean;
  markSeen: (id: string) => void;
  unseenCount: number;
}

function readSeenMap(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function writeSeenMap(map: SeenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable (private mode, sandbox). Treat writes as no-ops.
  }
}

export function useReleaseSeenState(): ReleaseSeenState {
  const [seen, setSeen] = useState<SeenMap>(readSeenMap);

  const isSeen = (id: string) => Boolean(seen[id]);

  const markSeen = (id: string) => {
    if (seen[id]) return;
    const next: SeenMap = {
      ...seen,
      [id]: { seenAt: new Date().toISOString() },
    };
    writeSeenMap(next);
    setSeen(next);
  };

  const unseenCount = RELEASES.reduce(
    (count, release) => (seen[release.id] ? count : count + 1),
    0,
  );

  return { isSeen, markSeen, unseenCount };
}
