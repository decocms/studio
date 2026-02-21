import { useReducer } from "react";

const MAX_HISTORY = 100;

export interface UndoRedoState<T> {
  past: T[];
  present: T;
  future: T[];
}

export type UndoRedoAction<T> =
  | { type: "PUSH"; payload: T }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESET"; payload: T };

export function undoRedoReducer<T>(
  state: UndoRedoState<T>,
  action: UndoRedoAction<T>,
): UndoRedoState<T> {
  switch (action.type) {
    case "PUSH": {
      const newPast = [...state.past, state.present];
      // Cap at MAX_HISTORY by dropping oldest entries
      const trimmedPast =
        newPast.length > MAX_HISTORY
          ? newPast.slice(newPast.length - MAX_HISTORY)
          : newPast;
      return { past: trimmedPast, present: action.payload, future: [] };
    }
    case "UNDO": {
      if (state.past.length === 0) return state;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const previous = state.past[state.past.length - 1]!;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const next = state.future[0]!;
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
      };
    }
    case "RESET": {
      return { past: [], present: action.payload, future: [] };
    }
    default:
      return state;
  }
}

export interface UseUndoRedoResult<T> {
  value: T;
  push: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: (next: T) => void;
}

export function useUndoRedo<T>(initial: T): UseUndoRedoResult<T> {
  const [state, dispatch] = useReducer(undoRedoReducer<T>, {
    past: [],
    present: initial,
    future: [],
  });

  return {
    value: state.present,
    push: (next: T) => dispatch({ type: "PUSH", payload: next }),
    undo: () => dispatch({ type: "UNDO" }),
    redo: () => dispatch({ type: "REDO" }),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    reset: (next: T) => dispatch({ type: "RESET", payload: next }),
  };
}
