/**
 * Tile board — responsive 1/2/3-column grid below the chat. No drag,
 * no resize — tiles appear as the user starts their corresponding
 * preset task and link back to that chat when clicked.
 */

import { TILES } from "./registry";
import type { TileState } from "./types";

export function TileBoard({ tiles }: { tiles: TileState[] }) {
  if (tiles.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {tiles.map((state) => {
        const def = TILES[state.id];
        return (
          <div key={state.id} className="min-h-[220px]">
            <def.Render state={state} />
          </div>
        );
      })}
    </div>
  );
}
