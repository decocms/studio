/**
 * Generic drag/resize tile board. Caller supplies positioned tiles and
 * mutators; content goes through `renderTile`. dnd-kit handles the
 * pointer drag — pixel delta is converted to cell delta against the
 * live board rect captured on drag start.
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import { DotsGrid, DotsHorizontal, Trash01 } from "@untitledui/icons";
import { type ReactNode, useRef, useState } from "react";
import {
  ALL_SIZES,
  GRID_COLS,
  GRID_GAP_PX,
  ROW_HEIGHT_PX,
  SIZE_LABELS,
  SIZE_PRESETS,
} from "./constants";
import { TileErrorBoundary } from "./tile-error-boundary";
import type { TileInstance, TileSizeKey } from "./types";

interface TileBoardProps {
  tiles: TileInstance[];
  isEditMode: boolean;
  renderTile: (tile: TileInstance) => ReactNode;
  onMove: (id: string, to: { x: number; y: number }) => void;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onRemove: (id: string) => void;
}

interface DragState {
  cellWidth: number;
  cellHeight: number;
}

export function TileBoard({
  tiles,
  isEditMode,
  renderTile,
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

  const filledRows = tiles.reduce((max, t) => Math.max(max, t.y + t.h), 0);
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
    const tile = tiles.find((t) => t.id === id);
    if (!tile) return;
    const dx = Math.round(event.delta.x / state.cellWidth);
    const dy = Math.round(event.delta.y / state.cellHeight);
    if (dx === 0 && dy === 0) return;
    onMove(id, { x: tile.x + dx, y: tile.y + dy });
  };

  if (isMobile) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-8">
        {tiles.map((tile) => (
          <div
            key={tile.id}
            className="bg-card card-shadow rounded-2xl overflow-hidden"
            style={{ minHeight: ROW_HEIGHT_PX }}
          >
            <TileErrorBoundary>{renderTile(tile)}</TileErrorBoundary>
          </div>
        ))}
      </div>
    );
  }

  const activeTile = activeId ? tiles.find((t) => t.id === activeId) : null;

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
        {isEditMode && <GridSkeleton rows={totalRows} tiles={tiles} />}
        {tiles.map((tile) => (
          <BoardTile
            key={tile.id}
            tile={tile}
            isEditMode={isEditMode}
            isDragging={activeId === tile.id}
            onResize={onResize}
            onRemove={onRemove}
          >
            {renderTile(tile)}
          </BoardTile>
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
          <div className="bg-card card-shadow rounded-2xl shadow-2xl ring-2 ring-primary/40 h-full overflow-hidden opacity-95">
            <TileErrorBoundary>{renderTile(activeTile)}</TileErrorBoundary>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

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
  children: ReactNode;
}

function BoardTile({
  tile,
  isEditMode,
  isDragging,
  onResize,
  onRemove,
  children,
}: BoardTileProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    isDragging: dragging,
  } = useDraggable({ id: tile.id, disabled: !isEditMode });

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
        !isCurrentlyDragging &&
          "transition-[left,top,width,height,opacity] duration-200 ease-out",
        isCurrentlyDragging && "opacity-30",
      )}
      style={{ left, top, width, height }}
    >
      <div
        className={cn(
          "relative h-full bg-card card-shadow rounded-2xl overflow-hidden",
          isEditMode &&
            "outline outline-1 outline-transparent hover:outline-primary/40",
        )}
      >
        {isEditMode && (
          <>
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="absolute top-2 left-2 z-10 flex size-8 items-center justify-center rounded-md bg-background/90 border border-border text-muted-foreground hover:text-foreground hover:bg-muted cursor-grab active:cursor-grabbing"
              aria-label="Drag tile"
            >
              <DotsGrid size={16} />
            </button>
            <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
              <TileMenu tile={tile} onResize={onResize} onRemove={onRemove} />
            </div>
          </>
        )}
        <div className="h-full overflow-hidden">
          <TileErrorBoundary>{children}</TileErrorBoundary>
        </div>
      </div>
    </div>
  );
}

export function TileMenu({
  tile,
  onResize,
  onRemove,
}: {
  tile: TileInstance;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onRemove: (id: string) => void;
}) {
  const minW = tile.minW ?? 1;
  const minH = tile.minH ?? 1;
  // Drop presets that would shrink the tile below its declared minimum —
  // e.g. an embedded UI tile needs at least 2 rows to leave room for the
  // iframe under the header.
  const allowed = ALL_SIZES.filter((key) => {
    const size = SIZE_PRESETS[key];
    return size.w >= minW && size.h >= minH;
  });

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
          className="flex size-8 items-center justify-center rounded-md bg-background/90 border border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          aria-label="Tile options"
        >
          <DotsHorizontal size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Size</DropdownMenuLabel>
        {allowed.map((key) => {
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
