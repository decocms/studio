/**
 * Persistence seam for the home-board layout — local-first, server-backed.
 *
 * localStorage is a synchronous cache mirror: the board paints instantly from
 * the last-known layout (no skeleton) while the org-scoped KV store
 * (`/api/:org/kv/:key`) reconciles in the background as the cross-device
 * source of truth. Writes go through both. The layout algebra in
 * `use-board-layout.ts` consumes the `BoardLayoutStore` interface and stays
 * storage-agnostic — swapping the backend means replacing only this file.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { BoardLayout } from "./types";

export const STORAGE_VERSION = 1;

/** KV key under which a board layout lives on the server. Org scoping is
 *  implicit in the endpoint; the version is kept in the key so a future
 *  schema bump can migrate without clobbering v1. */
const KV_KEY = `home-board.layout.v${STORAGE_VERSION}`;

/** localStorage mirror key — scoped per org so multiple orgs in one browser
 *  don't share a cache entry. */
function cacheKey(orgSlug: string): string {
  return `home-board.layout.v${STORAGE_VERSION}.${orgSlug}`;
}

const DEFAULT_LAYOUT: BoardLayout = {
  version: STORAGE_VERSION,
  tiles: {},
  hidden: [],
};

export interface BoardLayoutStore {
  /** Current layout — cached value first, reconciled with the server. */
  layout: BoardLayout;
  /** True only on a cold load with no cached layout (first paint waits for
   *  the server); false whenever a cached layout is available. */
  isLoading: boolean;
  /** Persist a full replacement layout (write-through: cache + server). */
  save: (layout: BoardLayout) => void;
}

function normalize(value: BoardLayout | undefined | null): BoardLayout {
  if (!value || value.version !== STORAGE_VERSION) return DEFAULT_LAYOUT;
  return {
    version: STORAGE_VERSION,
    tiles: value.tiles ?? {},
    hidden: Array.isArray(value.hidden) ? value.hidden : [],
  };
}

function isMeaningful(layout: BoardLayout): boolean {
  return Object.keys(layout.tiles).length > 0 || layout.hidden.length > 0;
}

function readCache(orgSlug: string): BoardLayout | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(orgSlug));
    if (!raw) return undefined;
    return normalize(JSON.parse(raw) as BoardLayout);
  } catch {
    return undefined;
  }
}

function writeCache(orgSlug: string, layout: BoardLayout): void {
  try {
    localStorage.setItem(cacheKey(orgSlug), JSON.stringify(layout));
  } catch {
    // Quota / unavailable storage — server remains the source of truth.
  }
}

async function putLayout(orgSlug: string, layout: BoardLayout): Promise<void> {
  const res = await fetch(`/api/${orgSlug}/kv/${KV_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(layout),
  });
  if (!res.ok) throw new Error("Failed to save board layout");
}

export function useBoardLayoutStore(orgSlug: string): BoardLayoutStore {
  const queryClient = useQueryClient();
  const queryKey = KEYS.boardLayout(orgSlug);
  const cached = readCache(orgSlug);

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async (): Promise<BoardLayout> => {
      const res = await fetch(`/api/${orgSlug}/kv/${KV_KEY}`);
      // Nothing on the server yet. If this browser has a meaningful local
      // layout (e.g. from before server persistence), migrate it up rather
      // than discarding the user's arrangement.
      if (res.status === 404) {
        if (cached && isMeaningful(cached)) {
          await putLayout(orgSlug, cached);
          return cached;
        }
        return DEFAULT_LAYOUT;
      }
      if (!res.ok) throw new Error("Failed to load board layout");
      const json = (await res.json()) as { value: BoardLayout };
      const server = normalize(json.value);
      writeCache(orgSlug, server);
      return server;
    },
    // Seed from cache for instant paint; reconcile with the server on mount.
    initialData: cached,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const mutation = useMutation({
    mutationFn: (next: BoardLayout) => putLayout(orgSlug, next),
  });

  const save = (next: BoardLayout) => {
    // Write-through: mirror + cache update are synchronous so drag/resize
    // feels instant; the PUT trails. A failed write leaves the optimistic
    // value in place; the next successful save reconciles it.
    writeCache(orgSlug, next);
    queryClient.setQueryData(queryKey, next);
    mutation.mutate(next);
  };

  return { layout: normalize(data), isLoading, save };
}
