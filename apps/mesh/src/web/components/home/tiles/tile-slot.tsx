/**
 * TileSlot — wraps a tile's renderer in the standard error + suspense
 * boundary so the host (TileBoard, mobile list, DragOverlay) doesn't
 * have to duplicate that triplet at every callsite.
 */

import { Suspense } from "react";
import { TileErrorBoundary } from "./tile-error-boundary";
import { TileSkeleton } from "./renderers";
import { getTileDefinition, renderTileContent } from "./registry";
import type { TileInstance } from "./types";

interface Props {
  tile: TileInstance;
  isEditMode: boolean;
}

export function TileSlot({ tile, isEditMode }: Props) {
  const def = getTileDefinition(tile.type);
  const Renderer = def?.render;
  return (
    <TileErrorBoundary>
      <Suspense fallback={<TileSkeleton />}>
        {Renderer ? (
          <Renderer instance={tile} isEditMode={isEditMode} />
        ) : (
          renderTileContent(tile.type, { instance: tile, isEditMode })
        )}
      </Suspense>
    </TileErrorBoundary>
  );
}
