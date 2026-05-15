/**
 * Source of truth for the user's home tile board. BE-owned: GET reads
 * the per-user board from `/api/:org/home-board`, mutations PATCH /
 * DELETE individual tiles. Move/resize/remove run optimistically against
 * the React Query cache so the grid stays snappy under drag.
 *
 * Auto-pin (a tile per started preset) happens server-side in
 * `POST /preset-tasks/:id/start`, so there is no `addTile` on this
 * surface; callers invalidate the home-board key after a successful
 * start (or just let the next query refetch) to pull the new tile in.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { HomeBoard, TileInstance } from "./types";

const EMPTY_BOARD: HomeBoard = { version: 3, tiles: [] };

interface BackendHomeBoardTile {
  id: string;
  presetId: string;
  taskId: string;
  virtualMcpId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BackendHomeBoard {
  tiles: BackendHomeBoardTile[];
}

function toTileInstance(t: BackendHomeBoardTile): TileInstance {
  return {
    id: t.id,
    x: t.x,
    y: t.y,
    w: t.w,
    h: t.h,
    config: {
      presetId: t.presetId,
      taskId: t.taskId,
      virtualMcpId: t.virtualMcpId,
    },
  };
}

async function fetchBoard(orgSlug: string): Promise<HomeBoard> {
  const res = await fetch(`/api/${orgSlug}/home-board`);
  if (!res.ok) throw new Error("Failed to load home board");
  const body = (await res.json()) as BackendHomeBoard;
  return { version: 3, tiles: body.tiles.map(toTileInstance) };
}

export interface UseHomeBoardResult {
  board: HomeBoard;
  isLoading: boolean;
  clearAll: () => void;
  removeTile: (id: string) => void;
  moveTile: (id: string, to: { x: number; y: number }) => void;
  resizeTile: (id: string, size: { w: number; h: number }) => void;
}

type MutationContext = { previous: HomeBoard | undefined };

export function useHomeBoard(orgSlug: string): UseHomeBoardResult {
  const queryClient = useQueryClient();
  const queryKey = KEYS.homeBoard(orgSlug);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchBoard(orgSlug),
  });

  function snapshotAndPatch(
    updater: (board: HomeBoard) => HomeBoard,
  ): MutationContext {
    queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<HomeBoard>(queryKey);
    queryClient.setQueryData<HomeBoard>(queryKey, (curr) =>
      updater(curr ?? EMPTY_BOARD),
    );
    return { previous };
  }

  function rollback(context: MutationContext | undefined) {
    if (context?.previous) {
      queryClient.setQueryData(queryKey, context.previous);
    }
  }

  const patchTile = useMutation<
    void,
    Error,
    {
      tileId: string;
      patch: Partial<Pick<TileInstance, "x" | "y" | "w" | "h">>;
    },
    MutationContext
  >({
    mutationFn: async ({ tileId, patch }) => {
      const res = await fetch(`/api/${orgSlug}/home-board/tiles/${tileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Failed to update tile");
    },
    onMutate: ({ tileId, patch }) =>
      snapshotAndPatch((b) => ({
        ...b,
        tiles: b.tiles.map((t) => (t.id === tileId ? { ...t, ...patch } : t)),
      })),
    onError: (_err, _vars, context) => rollback(context),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const deleteTile = useMutation<void, Error, string, MutationContext>({
    mutationFn: async (tileId) => {
      const res = await fetch(`/api/${orgSlug}/home-board/tiles/${tileId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove tile");
    },
    onMutate: (tileId) =>
      snapshotAndPatch((b) => ({
        ...b,
        tiles: b.tiles.filter((t) => t.id !== tileId),
      })),
    onError: (_err, _vars, context) => rollback(context),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const clear = useMutation<void, Error, void, MutationContext>({
    mutationFn: async () => {
      const res = await fetch(`/api/${orgSlug}/home-board`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to clear home board");
    },
    onMutate: () => snapshotAndPatch(() => EMPTY_BOARD),
    onError: (_err, _vars, context) => rollback(context),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  return {
    board: query.data ?? EMPTY_BOARD,
    isLoading: query.isLoading,
    clearAll: () => clear.mutate(),
    removeTile: (id) => deleteTile.mutate(id),
    moveTile: (id, to) => patchTile.mutate({ tileId: id, patch: to }),
    resizeTile: (id, size) => patchTile.mutate({ tileId: id, patch: size }),
  };
}
