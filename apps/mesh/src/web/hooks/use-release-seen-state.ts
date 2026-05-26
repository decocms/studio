import { useSyncExternalStore } from "react";
import { RELEASES } from "@/web/lib/release-feed";

const STORAGE_KEY = "studio.release-feed.v1";

type SeenMap = Record<string, { seenAt: string }>;

export interface ReleaseSeenState {
  isSeen: (id: string) => boolean;
  markSeen: (id: string) => void;
  unseenCount: number;
}

const listeners = new Set<() => void>();
let cachedSerialized = "";
let cachedSnapshot: SeenMap = {};
let writeFailed = false;

function readSerialized(): string {
  if (writeFailed) return cachedSerialized || "{}";
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "{}";
  } catch {
    return cachedSerialized || "{}";
  }
}

function parse(serialized: string): SeenMap {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function getSnapshot(): SeenMap {
  const serialized = readSerialized();
  if (serialized !== cachedSerialized) {
    cachedSerialized = serialized;
    cachedSnapshot = parse(serialized);
  }
  return cachedSnapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    // Bypass the writeFailed latch: another tab successfully wrote, so
    // refresh from localStorage. Union with cachedSnapshot so any locally
    // pending entries (from prior failed writes) aren't lost.
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? "{}";
      const remote = parse(raw);
      const merged: SeenMap = { ...remote, ...cachedSnapshot };
      cachedSnapshot = merged;
      cachedSerialized = JSON.stringify(merged);
    } catch {
      // ignore — fall through to listener so we at least re-render
    }
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function commit(next: SeenMap): void {
  cachedSnapshot = next;
  cachedSerialized = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, cachedSerialized);
    writeFailed = false;
  } catch {
    // localStorage write unavailable (private-mode quota, sandbox).
    // Latch so subsequent reads don't clobber the in-memory state.
    writeFailed = true;
  }
  listeners.forEach((l) => l());
}

export function useReleaseSeenState(): ReleaseSeenState {
  const seen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const isSeen = (id: string) => Boolean(seen[id]);

  const markSeen = (id: string) => {
    if (seen[id]) return;
    commit({
      ...seen,
      [id]: { seenAt: new Date().toISOString() },
    });
  };

  const unseenCount = RELEASES.reduce(
    (count, release) => (seen[release.id] ? count : count + 1),
    0,
  );

  return { isSeen, markSeen, unseenCount };
}
