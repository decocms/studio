/**
 * Tile board — the 12-column drag/resize grid that backs the
 * "tiles" home layout. Pure presentation: takes a board + mutators
 * from `useHomeBoard` and renders read-only or edit-mode chrome.
 *
 * Drag math: each tile's pixel-delta from dnd-kit is converted to a
 * cell-delta using the live grid cell width (read on drag end). The
 * tile's new {x,y} is committed via `moveTile`, which compacts the
 * board so neighbours stay tidy.
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
  ROW_HEIGHT_PX,
  SIZE_LABELS,
  SIZE_PRESETS,
} from "./constants";
import { getTileDefinition, renderTileContent } from "./registry";
import type { HomeBoard, TileInstance, TileSizeKey } from "./types";
import { TileErrorBoundary } from "./tile-error-boundary";

interface TileBoardProps {
  board: HomeBoard;
  isEditMode: boolean;
  onMove: (id: string, to: { x: number; y: number }) => void;
  onResize: (id: string, size: { w: number; h: number }) => void;
  onRemove: (id: string) => void;
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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor),
  );

  const totalRows = board.tiles.reduce(
    (max, t) => Math.max(max, t.y + t.h),
    isEditMode ? 6 : 1,
  );

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const id = String(event.active.id);
    const tile = board.tiles.find((t) => t.id === id);
    if (!tile) return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cellWidth = rect.width / GRID_COLS;
    if (cellWidth <= 0) return;
    const dx = Math.round(event.delta.x / cellWidth);
    const dy = Math.round(event.delta.y / ROW_HEIGHT_PX);
    if (dx === 0 && dy === 0) return;
    onMove(id, { x: tile.x + dx, y: tile.y + dy });
  };

  if (isMobile) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-8">
        {board.tiles.map((tile) => (
          <div
            key={tile.id}
            className="bg-background border border-border rounded-[0.75rem] overflow-hidden"
            style={{ minHeight: ROW_HEIGHT_PX * Math.max(2, tile.h) }}
          >
            <TileErrorBoundary>
              {renderTileContent(tile.type, {
                instance: tile,
                isEditMode: false,
              })}
            </TileErrorBoundary>
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
        className={cn(
          "relative w-full",
          isEditMode &&
            "bg-[radial-gradient(circle_at_center,var(--border)_1px,transparent_1px)] bg-[size:32px_32px]",
        )}
        style={{
          height: totalRows * ROW_HEIGHT_PX,
          minHeight: ROW_HEIGHT_PX * 4,
        }}
      >
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
          width: activeTile
            ? `calc((100cqw - 5rem) / ${GRID_COLS} * ${activeTile.w})`
            : undefined,
          height: activeTile ? activeTile.h * ROW_HEIGHT_PX : undefined,
        }}
      >
        {activeTile && (
          <div className="bg-background border border-primary rounded-[0.75rem] shadow-2xl ring-2 ring-primary/40 h-full overflow-hidden opacity-95">
            <TileErrorBoundary>
              {renderTileContent(activeTile.type, {
                instance: activeTile,
                isEditMode: true,
              })}
            </TileErrorBoundary>
          </div>
        )}
      </DragOverlay>
    </DndContext>
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
  const def = getTileDefinition(tile.type);

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

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute p-1.5 transition-opacity",
        (dragging || isDragging) && "opacity-30",
      )}
      style={{ left, top, width, height }}
    >
      <div
        className={cn(
          "relative h-full bg-background border border-border rounded-[0.75rem] overflow-hidden",
          isEditMode && "ring-1 ring-border hover:ring-primary/40",
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
          <TileErrorBoundary>
            {def
              ? def.render({ instance: tile, isEditMode })
              : renderTileContent(tile.type, {
                  instance: tile,
                  isEditMode,
                })}
          </TileErrorBoundary>
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
