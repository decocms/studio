/**
 * Pure layout math for the home tile grid. No DOM, no React.
 *
 * The grid is 12-col, infinite rows tall. Tiles must:
 *   - stay inside the column bounds (x + w <= 12)
 *   - never overlap another tile
 * After any mutation we run vertical compaction so the user never sees
 * gaps that aren't intentional.
 */

import { GRID_COLS } from "./constants";
import type { TileInstance } from "./types";

function rectsOverlap(a: TileInstance, b: TileInstance): boolean {
  if (a.id === b.id) return false;
  const aRight = a.x + a.w;
  const aBottom = a.y + a.h;
  const bRight = b.x + b.w;
  const bBottom = b.y + b.h;
  return a.x < bRight && aRight > b.x && a.y < bBottom && aBottom > b.y;
}

function clampX(tile: TileInstance): TileInstance {
  const maxX = GRID_COLS - tile.w;
  if (maxX < 0) return { ...tile, x: 0, w: GRID_COLS };
  return { ...tile, x: Math.min(Math.max(tile.x, 0), maxX) };
}

/**
 * Resolves overlaps by pushing the conflicting tile straight down until
 * the slot is clear. Stable order: caller passes `pinned` first.
 */
export function resolveCollisions(
  pinned: TileInstance,
  others: TileInstance[],
): TileInstance[] {
  const result: TileInstance[] = [pinned];
  const queue = [...others];
  while (queue.length > 0) {
    const next = queue.shift()!;
    let candidate = clampX(next);
    let safety = 0;
    while (result.some((existing) => rectsOverlap(candidate, existing))) {
      candidate = { ...candidate, y: candidate.y + 1 };
      if (++safety > 200) break;
    }
    result.push(candidate);
  }
  return result;
}

/**
 * Vertical compaction: every tile floats up until it hits another tile
 * or the top of the board. Iterates row-major top-to-bottom so order is
 * deterministic.
 */
export function compactBoard(tiles: TileInstance[]): TileInstance[] {
  const sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: TileInstance[] = [];
  for (const tile of sorted) {
    let candidate = clampX(tile);
    while (
      candidate.y > 0 &&
      !placed.some((p) => rectsOverlap({ ...candidate, y: candidate.y - 1 }, p))
    ) {
      candidate = { ...candidate, y: candidate.y - 1 };
    }
    placed.push(candidate);
  }
  return placed;
}

/**
 * Finds the topmost row at column 0 where a tile of size {w,h} fits
 * without colliding with any existing tile. Used by "Add tile".
 */
export function findFirstFreeSlot(
  tiles: TileInstance[],
  w: number,
  h: number,
): { x: number; y: number } {
  const safeW = Math.min(w, GRID_COLS);
  const maxRows = Math.max(0, ...tiles.map((t) => t.y + t.h)) + h;
  for (let y = 0; y <= maxRows; y++) {
    for (let x = 0; x <= GRID_COLS - safeW; x++) {
      const probe = { id: "__probe", type: "", x, y, w: safeW, h };
      if (!tiles.some((t) => rectsOverlap(probe, t))) {
        return { x, y };
      }
    }
  }
  return { x: 0, y: maxRows };
}

/**
 * Returns a tile in `tiles` (excluding `excludeId`) whose rect contains the
 * point (px, py) in cell coordinates, if any. Used to detect "drop on top
 * of another tile → swap" instead of push-down.
 */
function tileAtPoint(
  tiles: TileInstance[],
  excludeId: string,
  px: number,
  py: number,
): TileInstance | undefined {
  return tiles.find(
    (t) =>
      t.id !== excludeId &&
      px >= t.x &&
      px < t.x + t.w &&
      py >= t.y &&
      py < t.y + t.h,
  );
}

export function moveTile(
  tiles: TileInstance[],
  id: string,
  to: { x: number; y: number },
): TileInstance[] {
  const target = tiles.find((t) => t.id === id);
  if (!target) return tiles;

  const dropX = Math.max(0, Math.min(GRID_COLS - target.w, to.x));
  const dropY = Math.max(0, to.y);

  // Center-point swap detection. More forgiving than top-left.
  const centerX = dropX + Math.floor(target.w / 2);
  const centerY = dropY + Math.floor(target.h / 2);
  const occupant = tileAtPoint(tiles, id, centerX, centerY);

  // Same-size occupant → preserve both anchors exactly so the user sees
  // a clean swap. We deliberately skip compaction here; the result is
  // already gap-free by construction.
  if (occupant && occupant.w === target.w && occupant.h === target.h) {
    return tiles.map((t) => {
      if (t.id === id) return { ...t, x: occupant.x, y: occupant.y };
      if (t.id === occupant.id) return { ...t, x: target.x, y: target.y };
      return t;
    });
  }

  // Otherwise: place at the drop position, resolve collisions, then
  // compact so neighbours pack against the top of the board. This is
  // what stops "drop tile far below" leaving a sea of empty cells above.
  const moved = clampX({ ...target, x: dropX, y: dropY });
  const others = tiles.filter((t) => t.id !== id);
  return compactBoard(resolveCollisions(moved, others));
}

export function resizeTile(
  tiles: TileInstance[],
  id: string,
  size: { w: number; h: number },
): TileInstance[] {
  const target = tiles.find((t) => t.id === id);
  if (!target) return tiles;
  const resized = clampX({ ...target, w: size.w, h: size.h });
  const others = tiles.filter((t) => t.id !== id);
  return compactBoard(resolveCollisions(resized, others));
}

export function insertTile(
  tiles: TileInstance[],
  tile: Omit<TileInstance, "x" | "y">,
): TileInstance[] {
  const slot = findFirstFreeSlot(tiles, tile.w, tile.h);
  return compactBoard([...tiles, { ...tile, x: slot.x, y: slot.y }]);
}

export function removeTile(tiles: TileInstance[], id: string): TileInstance[] {
  return compactBoard(tiles.filter((t) => t.id !== id));
}

export function pixelDeltaToCellDelta(
  pixelDelta: { x: number; y: number },
  cellWidth: number,
  cellHeight: number,
): { dx: number; dy: number } {
  return {
    dx: Math.round(pixelDelta.x / cellWidth),
    dy: Math.round(pixelDelta.y / cellHeight),
  };
}
