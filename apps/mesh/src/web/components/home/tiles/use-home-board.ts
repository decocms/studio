/**
 * Single source of truth for the user's home tile board. Persists to
 * localStorage; the [board, setBoard] pair is sync-friendly so we can
 * swap the backing store for a server mutation without changing any
 * callsite.
 */

import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import type { HomeBoard, TileInstance } from "./types";
import { insertTile, moveTile, removeTile, resizeTile } from "./grid-utils";

const EMPTY_BOARD: HomeBoard = { version: 3, tiles: [] };

export interface UseHomeBoardResult {
  board: HomeBoard;
  clearAll: () => void;
  addTile: (tile: Omit<TileInstance, "x" | "y">) => void;
  removeTile: (id: string) => void;
  moveTile: (id: string, to: { x: number; y: number }) => void;
  resizeTile: (id: string, size: { w: number; h: number }) => void;
}

export function useHomeBoard(orgSlug: string): UseHomeBoardResult {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "anon";
  const key = LOCALSTORAGE_KEYS.homeBoard(orgSlug, userId);
  const [board, setBoard] = useLocalStorage<HomeBoard>(key, EMPTY_BOARD);

  return {
    board,
    clearAll: () => setBoard(EMPTY_BOARD),
    addTile: (tile) =>
      setBoard((prev) => ({ ...prev, tiles: insertTile(prev.tiles, tile) })),
    removeTile: (id) =>
      setBoard((prev) => ({ ...prev, tiles: removeTile(prev.tiles, id) })),
    moveTile: (id, to) =>
      setBoard((prev) => ({ ...prev, tiles: moveTile(prev.tiles, id, to) })),
    resizeTile: (id, size) =>
      setBoard((prev) => ({
        ...prev,
        tiles: resizeTile(prev.tiles, id, size),
      })),
  };
}
