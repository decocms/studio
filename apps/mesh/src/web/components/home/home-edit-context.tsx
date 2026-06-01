/**
 * Home edit-session state. Customizing the board is a *draft*: tile
 * moves/resizes/hides apply live to the rendered board but are held
 * locally until the user hits Save (which flushes to the server) or
 * Cancel (which discards back to the last-saved layout). Pinning
 * (add/remove agent/prompt/tile) is intentionally *not* part of this
 * draft — it writes to the server immediately and reflects live.
 *
 * The store seam (`useBoardLayoutStore`) is owned here so both the
 * toolbar (Save/Cancel) and the board (reads + mutations) share one
 * source of truth.
 */

import { createContext, type ReactNode, useContext, useState } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useBoardLayoutStore } from "./tile-board/board-layout-store";
import type { BoardLayout } from "./tile-board/types";

interface HomeEditContextValue {
  isEditMode: boolean;
  enter: () => void;
  cancel: () => void;
  save: () => void;
  /** True when the draft diverges from the persisted layout — gates the
   *  Save button so an untouched session can't issue a no-op write. */
  hasChanges: boolean;
  /** Layout the board should render & mutate: the draft while editing,
   *  the persisted layout otherwise. */
  layout: BoardLayout;
  isLayoutLoading: boolean;
  /** Apply a layout change. Stages into the draft while editing;
   *  write-through to the store otherwise. */
  commitLayout: (next: BoardLayout) => void;
}

const HomeEditContext = createContext<HomeEditContextValue | null>(null);

export function HomeEditProvider({ children }: { children: ReactNode }) {
  const { org } = useProjectContext();
  const store = useBoardLayoutStore(org.slug);
  const [isEditMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<BoardLayout | null>(null);

  const enter = () => {
    // Snapshot the persisted layout so Cancel has a baseline to revert to.
    setDraft(store.layout);
    setEditMode(true);
  };
  const cancel = () => {
    setDraft(null);
    setEditMode(false);
  };
  const save = () => {
    if (draft) store.save(draft);
    setDraft(null);
    setEditMode(false);
  };

  const editing = isEditMode && draft !== null;
  const layout = editing ? draft : store.layout;
  // Small plain objects — a structural compare is cheap and avoids
  // false "dirty" from object identity churn across renders.
  const hasChanges = editing
    ? JSON.stringify(draft) !== JSON.stringify(store.layout)
    : false;

  const commitLayout = (next: BoardLayout) => {
    if (isEditMode) setDraft(next);
    else store.save(next);
  };

  return (
    <HomeEditContext.Provider
      value={{
        isEditMode,
        enter,
        cancel,
        save,
        hasChanges,
        layout,
        isLayoutLoading: store.isLoading,
        commitLayout,
      }}
    >
      {children}
    </HomeEditContext.Provider>
  );
}

export function useHomeEdit(): HomeEditContextValue {
  const ctx = useContext(HomeEditContext);
  if (!ctx) {
    throw new Error("useHomeEdit must be used within a HomeEditProvider");
  }
  return ctx;
}
