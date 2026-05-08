/**
 * Tile board — the 3-column drag/resize grid that backs the home
 * "tiles" area. Pure presentation: takes a board + mutators from
 * `useHomeBoard` and renders read-only or edit-mode chrome.
 *
 * Edit-mode mechanics:
 *   - A CSS-grid skeleton of dashed cells renders behind the tiles so
 *     the user sees the 3-col structure before they drop something.
 *   - dnd-kit handles the pointer drag. Cell width is captured from
 *     the live board element on drag start (refs, not container
 *     queries) so the DragOverlay matches the tile's exact size.
 *   - Drop math: pointer pixel-delta → cell-delta. The dropped slot is
 *     committed via `moveTile`, which swaps with an occupant tile when
 *     possible (smoother than push-down) and otherwise compacts the
 *     board.
 *   - Tile positions animate via CSS transitions on left/top/width/
 *     height so neighbours slide cleanly when the board reflows.
 */

import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { DotsGrid, DotsHorizontal, Trash01 } from "@untitledui/icons";
import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  ALL_SIZES,
  GRID_COLS,
  GRID_GAP_PX,
  ROW_HEIGHT_PX,
  SIZE_LABELS,
  SIZE_PRESETS,
} from "./constants";
import { getTileDefinition } from "./registry";
import { TileSlot } from "./tile-slot";
import type { HomeBoard, TileInstance, TileSizeKey } from "./types";

interface TileBoardProps {
  board: HomeBoard;
  isEditMode: boolean;
  onMove: (id: string, to: { x: number; y: number }) => void;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onRemove: (id: string) => void;
}

interface DragState {
  cellWidth: number;
  cellHeight: number;
}

export function TileBoard({
  board,
  isEditMode,
  onMove,
  onResize,
  onRemove,
}: TileBoardProps) {
  const isMobile = useIsMobile();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor),
  );

  // Always render at least a couple of empty rows in edit mode so the
  // skeleton has something to draw against and the user can drop tiles
  // into space below the existing content.
  const filledRows = board.tiles.reduce(
    (max, t) => Math.max(max, t.y + t.h),
    0,
  );
  const totalRows = isEditMode
    ? Math.max(filledRows + 2, 4)
    : Math.max(filledRows, 1);

  const captureDragState = (): DragState | null => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      cellWidth: rect.width / GRID_COLS,
      cellHeight: ROW_HEIGHT_PX,
    };
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    setDragState(captureDragState());
  };

  const onDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id);
    const state = dragState ?? captureDragState();
    setActiveId(null);
    setDragState(null);
    if (!state || state.cellWidth <= 0) return;
    const tile = board.tiles.find((t) => t.id === id);
    if (!tile) return;
    const dx = Math.round(event.delta.x / state.cellWidth);
    const dy = Math.round(event.delta.y / state.cellHeight);
    if (dx === 0 && dy === 0) return;
    onMove(id, { x: tile.x + dx, y: tile.y + dy });
  };

  if (isMobile) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-8">
        {board.tiles.map((tile) => (
          <div
            key={tile.id}
            className="bg-background border border-border rounded-2xl overflow-hidden"
            style={{ minHeight: ROW_HEIGHT_PX }}
          >
            <TileSlot tile={tile} isEditMode={false} />
          </div>
        ))}
      </div>
    );
  }

  const activeTile = activeId
    ? board.tiles.find((t) => t.id === activeId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div
        ref={boardRef}
        className="relative w-full"
        style={{
          height: totalRows * ROW_HEIGHT_PX,
          minHeight: isEditMode ? ROW_HEIGHT_PX * 4 : ROW_HEIGHT_PX,
        }}
      >
        {isEditMode && <GridSkeleton rows={totalRows} tiles={board.tiles} />}
        {board.tiles.map((tile) => (
          <BoardTile
            key={tile.id}
            tile={tile}
            isEditMode={isEditMode}
            isDragging={activeId === tile.id}
            onResize={onResize}
            onRemove={onRemove}
          />
        ))}
      </div>
      <DragOverlay
        dropAnimation={null}
        style={{
          width:
            activeTile && dragState
              ? activeTile.w * dragState.cellWidth - GRID_GAP_PX
              : undefined,
          height:
            activeTile && dragState
              ? activeTile.h * dragState.cellHeight - GRID_GAP_PX
              : undefined,
        }}
      >
        {activeTile && (
          <div className="bg-background border border-primary rounded-2xl shadow-2xl ring-2 ring-primary/40 h-full overflow-hidden opacity-95">
            <TileSlot tile={activeTile} isEditMode={true} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Renders a dashed cell at every grid slot that isn't covered by a tile.
 * Sits behind the tiles in edit mode and only shows real empty drop
 * targets — no ghost lines bleeding through translucent tiles.
 */
function GridSkeleton({
  rows,
  tiles,
}: {
  rows: number;
  tiles: TileInstance[];
}) {
  const isCovered = (x: number, y: number) =>
    tiles.some((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h);

  const empties: { x: number; y: number }[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      if (!isCovered(x, y)) empties.push({ x, y });
    }
  }

  return (
    <div className="absolute inset-0 pointer-events-none">
      {empties.map((c) => (
        <div
          key={`${c.x}-${c.y}`}
          className="absolute p-1"
          style={{
            left: `${(c.x / GRID_COLS) * 100}%`,
            top: c.y * ROW_HEIGHT_PX,
            width: `${(1 / GRID_COLS) * 100}%`,
            height: ROW_HEIGHT_PX,
          }}
        >
          <div className="h-full w-full rounded-2xl border border-dashed border-border/60" />
        </div>
      ))}
    </div>
  );
}

interface BoardTileProps {
  tile: TileInstance;
  isEditMode: boolean;
  isDragging: boolean;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onRemove: (id: string) => void;
}

function BoardTile({
  tile,
  isEditMode,
  isDragging,
  onResize,
  onRemove,
}: BoardTileProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    isDragging: dragging,
  } = useDraggable({
    id: tile.id,
    disabled: !isEditMode,
  });

  const left = `${(tile.x / GRID_COLS) * 100}%`;
  const width = `${(tile.w / GRID_COLS) * 100}%`;
  const top = tile.y * ROW_HEIGHT_PX;
  const height = tile.h * ROW_HEIGHT_PX;

  const isCurrentlyDragging = dragging || isDragging;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute p-1 will-change-[left,top,width,height,opacity]",
        // Smooth slide when neighbours reflow; skip during drag so the
        // pointer-following transform reads as immediate.
        !isCurrentlyDragging &&
          "transition-[left,top,width,height,opacity] duration-200 ease-out",
        isCurrentlyDragging && "opacity-30",
      )}
      style={{ left, top, width, height }}
    >
      <div
        className={cn(
          "relative h-full bg-muted/30 dark:bg-muted/20 rounded-2xl overflow-hidden border border-transparent",
          isEditMode && "border-border hover:border-primary/40",
        )}
      >
        {isEditMode && (
          <>
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="absolute top-2 left-2 z-10 flex size-6 items-center justify-center rounded-md bg-background/90 border border-border text-muted-foreground hover:text-foreground hover:bg-muted cursor-grab active:cursor-grabbing"
              aria-label="Drag tile"
            >
              <DotsGrid size={12} />
            </button>
            <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
              <TileMenu tile={tile} onResize={onResize} onRemove={onRemove} />
            </div>
          </>
        )}
        <div className="h-full overflow-hidden">
          <TileSlot tile={tile} isEditMode={isEditMode} />
        </div>
      </div>
    </div>
  );
}

function TileMenu({
  tile,
  onResize,
  onRemove,
}: {
  tile: TileInstance;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onRemove: (id: string) => void;
}) {
  const def = getTileDefinition(tile.type);
  const supported = def?.supportedSizes ?? ALL_SIZES;

  const matchSizeKey = (): TileSizeKey | null => {
    for (const key of ALL_SIZES) {
      const size = SIZE_PRESETS[key];
      if (size.w === tile.w && size.h === tile.h) return key;
    }
    return null;
  };
  const currentKey = matchSizeKey();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md bg-background/90 border border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label="Tile options"
        >
          <DotsHorizontal size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Size</DropdownMenuLabel>
        {supported.map((key) => {
          const size = SIZE_PRESETS[key];
          return (
            <DropdownMenuItem
              key={key}
              onSelect={() => onResize(tile.id, size)}
              className="flex items-center justify-between"
            >
              <span>{SIZE_LABELS[key]}</span>
              <span className="text-xs text-muted-foreground">
                {currentKey === key ? "✓" : `${size.w}×${size.h}`}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onRemove(tile.id)}
          className="text-destructive focus:text-destructive"
        >
          <Trash01 size={14} className="mr-2" />
          Remove tile
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
