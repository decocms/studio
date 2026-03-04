/**
 * Chat state reducer and types
 *
 * Extracted from context.tsx so tests can import the reducer without
 * pulling in the entire UI dependency graph.
 */

import type { ParentTask } from "./types";

/**
 * Chat state — shared across the Decopilot chat provider.
 *
 * NOTE: tiptapDoc is intentionally NOT here — it lives as local state in
 * ChatInput to avoid re-rendering the entire context tree on every keystroke.
 */
export interface ChatState {
  /** Active parent task if branching is in progress */
  parentTask: ParentTask | null;
  /** Finish reason from the last chat completion */
  finishReason: string | null;
}

/**
 * Actions for the chat state reducer
 */
export type ChatStateAction =
  | { type: "START_BRANCH"; payload: ParentTask }
  | { type: "CLEAR_BRANCH" }
  | { type: "SET_FINISH_REASON"; payload: string | null }
  | { type: "CLEAR_FINISH_REASON" }
  | { type: "RESET" };

/**
 * Initial chat state
 */
export const initialChatState: ChatState = {
  parentTask: null,
  finishReason: null,
};

/**
 * Reducer for chat state
 */
export function chatStateReducer(
  state: ChatState,
  action: ChatStateAction,
): ChatState {
  switch (action.type) {
    case "START_BRANCH":
      return { ...state, parentTask: action.payload };
    case "CLEAR_BRANCH":
      return { ...state, parentTask: null };
    case "SET_FINISH_REASON":
      if (state.finishReason === action.payload) return state;
      return { ...state, finishReason: action.payload };
    case "CLEAR_FINISH_REASON":
      return { ...state, finishReason: null };
    case "RESET":
      return initialChatState;
    default:
      return state;
  }
}
