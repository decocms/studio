/**
 * Single source of truth for the user's home tile board. Persists to
 * localStorage today; the [board, setBoard] pair is sync-friendly so we
 * can swap the backing store for a server mutation without changing any
 * callsite.
 *
 * The home page itself always renders chat + agents on top — those are
 * not tiles. This board only governs the customisable area below.
 */

import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import type { HomeBoard, TileInstance } from "./types";
import { createEmptyBoard, createStarterBoard } from "./seed";
import { insertTile, moveTile, removeTile, resizeTile } from "./grid-utils";

export interface UseHomeBoardResult {
  board: HomeBoard;
  resetToStarter: () => void;
  clearAll: () => void;
  addTile: (tile: Omit<TileInstance, "x" | "y">) => void;
  removeTile: (id: string) => void;
  moveTile: (id: string, to: { x: number; y: number }) => void;
  resizeTile: (id: string, size: { w: number; h: number }) => void;
  updateTileConfig: (id: string, patch: Record<string, unknown>) => void;
}

const DEFAULT_BOARD: HomeBoard = createEmptyBoard();

/**
 * Migrate stored boards. v1 had a `layout: "simple" | "tiles"` field —
 * we drop it and keep whatever tiles the user had. A v1 board with an
 * empty tiles array (the simple-mode default) becomes an empty v2 board,
 * which renders identically to today's chat-centric home.
 */
function migrate(existing: unknown): HomeBoard {
  if (!existing || typeof existing !== "object") return DEFAULT_BOARD;
  const obj = existing as Record<string, unknown>;
  const tiles = Array.isArray(obj.tiles) ? (obj.tiles as TileInstance[]) : [];
  return { version: 2, tiles };
}

export function useHomeBoard(orgSlug: string): UseHomeBoardResult {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "anon";
  const key = LOCALSTORAGE_KEYS.homeBoard(orgSlug, userId);
  const [board, setBoard] = useLocalStorage<HomeBoard>(key, (existing) =>
    migrate(existing),
  );

  return {
    board,
    resetToStarter: () => setBoard(createStarterBoard()),
    clearAll: () => setBoard(createEmptyBoard()),
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
    updateTileConfig: (id, patch) =>
      setBoard((prev) => ({
        ...prev,
        tiles: prev.tiles.map((t) =>
          t.id === id ? { ...t, config: { ...t.config, ...patch } } : t,
        ),
      })),
  };
}
