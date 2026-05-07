/**
 * Single source of truth for the user's home board. Persists to
 * localStorage today; the [board, setBoard] pair shape is intentionally
 * sync-friendly so we can later swap the backing store for a server
 * mutation without changing any callsite.
 */

import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { authClient } from "@/web/lib/auth-client";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import type { HomeBoard, HomeLayoutMode, TileInstance } from "./types";
import { createSimpleBoard, createStarterTilesBoard } from "./seed";
import { insertTile, moveTile, removeTile, resizeTile } from "./grid-utils";

export interface UseHomeBoardResult {
  board: HomeBoard;
  setLayout: (mode: HomeLayoutMode) => void;
  switchToTiles: (seed?: "starter" | "empty") => void;
  switchToSimple: () => void;
  resetToStarter: () => void;
  addTile: (tile: Omit<TileInstance, "x" | "y">) => void;
  removeTile: (id: string) => void;
  moveTile: (id: string, to: { x: number; y: number }) => void;
  resizeTile: (id: string, size: { w: number; h: number }) => void;
  updateTileConfig: (id: string, patch: Record<string, unknown>) => void;
}

const DEFAULT_BOARD: HomeBoard = createSimpleBoard();

function migrate(existing: HomeBoard | undefined): HomeBoard {
  if (!existing || typeof existing !== "object") return DEFAULT_BOARD;
  if (existing.version !== 1) return DEFAULT_BOARD;
  if (existing.layout !== "simple" && existing.layout !== "tiles") {
    return DEFAULT_BOARD;
  }
  return {
    version: 1,
    layout: existing.layout,
    tiles: Array.isArray(existing.tiles) ? existing.tiles : [],
  };
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
    setLayout: (mode) => setBoard((prev) => ({ ...prev, layout: mode })),
    switchToTiles: (seed = "starter") =>
      setBoard((prev) => {
        if (prev.tiles.length > 0) return { ...prev, layout: "tiles" };
        if (seed === "empty") {
          return { version: 1, layout: "tiles", tiles: [] };
        }
        return createStarterTilesBoard();
      }),
    switchToSimple: () => setBoard((prev) => ({ ...prev, layout: "simple" })),
    resetToStarter: () => setBoard(createStarterTilesBoard()),
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
