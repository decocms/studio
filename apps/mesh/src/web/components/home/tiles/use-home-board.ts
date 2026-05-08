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

/**
 * No board stored yet → seed the starter layout. The user's first home
 * is a default tile set, not an empty canvas with a "create" banner.
 * Boards that exist with `tiles: []` (the user explicitly cleared) stay
 * empty so we don't reseed against their will.
 */
function firstLoadBoard(): HomeBoard {
  return createStarterBoard();
}

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

/**
 * Migrate stored boards.
 *
 * - v1 had a `layout: "simple" | "tiles"` field that we dropped in v2.
 * - v3 collapsed the grid from 12 cols to 3 cols and capped tile height
 *   at 2 rows (was 3). v2 tile positions/sizes get scaled down by 4 on
 *   the x-axis so the previous starter board's M/L/W tiles map cleanly
 *   to the new S/M/L/XL/W presets:
 *     v2 4x3 (M) → v3 1x2 (M)
 *     v2 6x3 (L) → v3 2x2 (XL)
 *     v2 12x2 (W) → v3 3x1 (W)
 *     v2 3x2 (S) → v3 1x1 (S)
 *   compactBoard at write time handles any residual overlap.
 */
function migrate(existing: unknown): HomeBoard {
  if (!existing || typeof existing !== "object") return firstLoadBoard();
  const obj = existing as Record<string, unknown>;
  const rawTiles = Array.isArray(obj.tiles)
    ? (obj.tiles as TileInstance[])
    : [];
  const fromV12Cols =
    obj.version === undefined || obj.version === 1 || obj.version === 2;
  const tiles: TileInstance[] = fromV12Cols
    ? rawTiles.map((t) => ({
        ...t,
        x: Math.min(2, Math.max(0, Math.round((t.x ?? 0) / 4))),
        w: Math.min(3, Math.max(1, Math.round((t.w ?? 4) / 4))),
        h: Math.min(2, Math.max(1, (t.h ?? 2) >= 3 ? 2 : 1)),
      }))
    : rawTiles;
  return { version: 3, tiles };
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
