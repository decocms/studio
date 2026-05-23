import { kvGet, kvSet, type KVStorage } from "./kv";

const kvKey = (userId: string) => `home-board:${userId}`;

export interface HomeBoardTile {
  id: string;
  /** Preset definition id this tile is bound to (e.g. "brand-context"). */
  presetId: string;
  /** Chat thread minted when the preset started — click target. */
  taskId: string;
  /** Pinned agent for the thread (forwarded as ?virtualmcpid=). */
  virtualMcpId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HomeBoard {
  tiles: HomeBoardTile[];
}

const EMPTY_BOARD: HomeBoard = { tiles: [] };

export class HomeBoardStore {
  constructor(private kv: KVStorage) {}

  get(organizationId: string, userId: string): Promise<HomeBoard> {
    return kvGet(this.kv, organizationId, kvKey(userId), EMPTY_BOARD);
  }

  set(organizationId: string, userId: string, board: HomeBoard): Promise<void> {
    return kvSet(this.kv, organizationId, kvKey(userId), board);
  }

  async addTile(
    organizationId: string,
    userId: string,
    tile: HomeBoardTile,
  ): Promise<void> {
    const board = await this.get(organizationId, userId);
    const next: HomeBoard = {
      tiles: [...board.tiles.filter((t) => t.id !== tile.id), tile],
    };
    await this.set(organizationId, userId, next);
  }

  async updateTile(
    organizationId: string,
    userId: string,
    tileId: string,
    patch: Partial<Pick<HomeBoardTile, "x" | "y" | "w" | "h">>,
  ): Promise<HomeBoardTile | null> {
    const board = await this.get(organizationId, userId);
    const current = board.tiles.find((t) => t.id === tileId);
    if (!current) return null;
    const updated: HomeBoardTile = { ...current, ...patch };
    const next: HomeBoard = {
      tiles: board.tiles.map((t) => (t.id === tileId ? updated : t)),
    };
    await this.set(organizationId, userId, next);
    return updated;
  }

  async removeTile(
    organizationId: string,
    userId: string,
    tileId: string,
  ): Promise<boolean> {
    const board = await this.get(organizationId, userId);
    const next: HomeBoard = {
      tiles: board.tiles.filter((t) => t.id !== tileId),
    };
    if (next.tiles.length === board.tiles.length) return false;
    await this.set(organizationId, userId, next);
    return true;
  }
}

/**
 * Computes the (x, y) for an auto-pinned tile of size (w, h). Picks the
 * topmost row at column 0 where the tile fits without overlapping an
 * existing one — matches the FE `findFirstFreeSlot` semantics so the
 * board looks the same after a server pin as it would after a client
 * add.
 */
export function pickAutoPinSlot(
  tiles: HomeBoardTile[],
  size: { w: number; h: number },
  gridCols: number,
): { x: number; y: number } {
  const w = Math.min(size.w, gridCols);
  const blockerAt = (y: number) =>
    tiles.find(
      (t) => 0 < t.x + t.w && w > t.x && y < t.y + t.h && y + size.h > t.y,
    );
  // Each iteration either returns or jumps past one blocker's bottom; since
  // y only increases, no tile blocks twice — terminates in ≤ tiles.length + 1.
  let y = 0;
  for (let i = 0; i <= tiles.length; i++) {
    const blocker = blockerAt(y);
    if (!blocker) return { x: 0, y };
    y = blocker.y + blocker.h;
  }
  return { x: 0, y };
}
