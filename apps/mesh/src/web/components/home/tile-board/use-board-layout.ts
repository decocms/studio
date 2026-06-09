/**
 * Layout algebra for the home board. Caller supplies the candidate tiles;
 * positions/sizes/hidden state come from the edit context (`useHomeEdit`)
 * and new candidates auto-place into the first free slot. This module is
 * storage-agnostic — in edit mode mutations stage into the draft, outside
 * it they write through; either way persistence lives behind the context.
 */

import { useHomeEdit } from "../home-edit-context";
import { STORAGE_VERSION } from "./board-layout-store";
import { DEFAULT_SIZE, GRID_COLS } from "./constants";
import type { BoardLayout, TileInstance } from "./types";

interface CandidateTile {
  id: string;
  defaultSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
  /** Pinned to home (in default_home_agents). Pinned candidates ignore the
   *  `hidden` list — membership is owned by the manage-home drawer now, so a
   *  stale board-level hide must never suppress an explicitly-pinned agent. */
  pinned?: boolean;
}

interface BoardSnapshot {
  /** Tiles currently placed on the board (visible + positioned). */
  visible: TileInstance[];
}

function isCovered(
  placed: Array<{ x: number; y: number; w: number; h: number }>,
  x: number,
  y: number,
): boolean {
  return placed.some(
    (t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h,
  );
}

function findFreeSpot(
  placed: Array<{ x: number; y: number; w: number; h: number }>,
  w: number,
  h: number,
): { x: number; y: number } {
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      let fits = true;
      for (let dy = 0; dy < h && fits; dy++) {
        for (let dx = 0; dx < w && fits; dx++) {
          if (isCovered(placed, x + dx, y + dy)) fits = false;
        }
      }
      if (fits) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function clampSize(
  w: number,
  h: number,
  min: { w: number; h: number } = { w: 1, h: 1 },
): { w: number; h: number } {
  const cw = Math.max(min.w, Math.min(GRID_COLS, w));
  const ch = Math.max(min.h, Math.min(6, h));
  return { w: cw, h: ch };
}

function clampPosition(
  x: number,
  y: number,
  w: number,
): { x: number; y: number } {
  const cx = Math.max(0, Math.min(GRID_COLS - w, x));
  const cy = Math.max(0, y);
  return { x: cx, y: cy };
}

/**
 * Try to swap two tiles' positions when they have matching dimensions —
 * gives a smoother feel than push-down for same-size drags. Falls back
 * to compaction (placing the dragged tile and re-flowing others into
 * free cells) when the slot is occupied by a differently-sized tile.
 */
function resolveCollision(
  tiles: TileInstance[],
  movedId: string,
  target: { x: number; y: number },
): TileInstance[] {
  const moved = tiles.find((t) => t.id === movedId);
  if (!moved) return tiles;
  const others = tiles.filter((t) => t.id !== movedId);
  const occupant = others.find(
    (t) =>
      target.x >= t.x &&
      target.x < t.x + t.w &&
      target.y >= t.y &&
      target.y < t.y + t.h,
  );
  if (occupant && occupant.w === moved.w && occupant.h === moved.h) {
    return tiles.map((t) => {
      if (t.id === movedId) return { ...t, x: occupant.x, y: occupant.y };
      if (t.id === occupant.id) return { ...t, x: moved.x, y: moved.y };
      return t;
    });
  }
  // Otherwise: place dragged tile and re-flow remaining tiles in order
  // into free cells (compaction).
  const placedSelf = { ...moved, x: target.x, y: target.y };
  const placed: TileInstance[] = [placedSelf];
  for (const other of others) {
    const spot = findFreeSpot(placed, other.w, other.h);
    placed.push({ ...other, x: spot.x, y: spot.y });
  }
  return placed;
}

export interface BoardLayoutApi {
  snapshot: BoardSnapshot;
  /** True until the persisted layout has loaded. */
  isLoading: boolean;
  moveTile: (id: string, to: { x: number; y: number }) => void;
  resizeTile: (id: string, size: { w: number; h: number }) => void;
  hideTile: (id: string) => void;
}

export function useBoardLayout(candidates: CandidateTile[]): BoardLayoutApi {
  const { layout, isLayoutLoading, commitLayout } = useHomeEdit();
  const hiddenSet = new Set(layout.hidden);

  // Build the visible-tile list deterministically from candidates +
  // layout. Auto-place anything that doesn't have a stored position yet.
  const placed: TileInstance[] = [];
  const visibleCandidates = candidates.filter(
    (c) => c.pinned || !hiddenSet.has(c.id),
  );
  const minByCandidate = new Map<string, { w: number; h: number }>();
  for (const cand of candidates) {
    if (cand.minSize) minByCandidate.set(cand.id, cand.minSize);
  }
  // Pass 1: place tiles that already have a stored position.
  for (const cand of visibleCandidates) {
    const stored = layout.tiles[cand.id];
    if (!stored) continue;
    const minSize = minByCandidate.get(cand.id);
    const { w, h } = clampSize(stored.w, stored.h, minSize);
    const { x, y } = clampPosition(stored.x, stored.y, w);
    placed.push({
      id: cand.id,
      x,
      y,
      w,
      h,
      minW: minSize?.w,
      minH: minSize?.h,
    });
  }
  // Pass 2: auto-place tiles without a stored position.
  for (const cand of visibleCandidates) {
    if (placed.some((t) => t.id === cand.id)) continue;
    const size = cand.defaultSize ?? DEFAULT_SIZE;
    const minSize = minByCandidate.get(cand.id);
    const { w, h } = clampSize(size.w, size.h, minSize);
    const spot = findFreeSpot(placed, w, h);
    placed.push({
      id: cand.id,
      x: spot.x,
      y: spot.y,
      w,
      h,
      minW: minSize?.w,
      minH: minSize?.h,
    });
  }

  const candidateIds = new Set(candidates.map((c) => c.id));

  const commit = (next: TileInstance[], hidden: string[]) => {
    const tiles: BoardLayout["tiles"] = {};
    for (const t of next) {
      tiles[t.id] = { x: t.x, y: t.y, w: t.w, h: t.h };
    }
    commitLayout({
      version: STORAGE_VERSION,
      tiles,
      hidden: hidden.filter((id) => candidateIds.has(id)),
    });
  };

  return {
    snapshot: { visible: placed },
    isLoading: isLayoutLoading,
    moveTile: (id, to) => {
      const tile = placed.find((t) => t.id === id);
      if (!tile) return;
      const clamped = clampPosition(to.x, to.y, tile.w);
      if (clamped.x === tile.x && clamped.y === tile.y) return;
      const resolved = resolveCollision(placed, id, clamped);
      commit(resolved, layout.hidden);
    },
    resizeTile: (id, size) => {
      const tile = placed.find((t) => t.id === id);
      if (!tile) return;
      const minSize = minByCandidate.get(id);
      const { w, h } = clampSize(size.w, size.h, minSize);
      if (w === tile.w && h === tile.h) return;
      // Re-pack everyone after a grow so we never leave overlaps.
      const resized = { ...tile, w, h, x: clampPosition(tile.x, tile.y, w).x };
      const others = placed.filter((t) => t.id !== id);
      const recomputed: TileInstance[] = [resized];
      for (const other of others) {
        const spot = findFreeSpot(recomputed, other.w, other.h);
        recomputed.push({ ...other, x: spot.x, y: spot.y });
      }
      commit(recomputed, layout.hidden);
    },
    hideTile: (id) => {
      const remaining = placed.filter((t) => t.id !== id);
      commit(remaining, Array.from(new Set([...layout.hidden, id])));
    },
  };
}
