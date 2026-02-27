/**
 * Tests for ChatState Reducer
 *
 * Tests the reducer logic for the chat state management.
 * NOTE: tiptapDoc was moved out of the reducer into ChatInput local state.
 */

import { describe, expect, test } from "bun:test";
import type { ParentThread } from "./types.ts";
import {
  chatStateReducer,
  type ChatState,
  type ChatStateAction,
} from "./chat-state";

describe("ChatState Reducer Logic", () => {
  const initialState: ChatState = {
    parentThread: null,
    finishReason: null,
  };

  test("should initialize with empty state", () => {
    expect(initialState.parentThread).toBeNull();
    expect(initialState.finishReason).toBeNull();
  });

  test("should start branch with START_BRANCH action", () => {
    const parentThread: ParentThread = {
      thread_id: "thread-123",
      messageId: "msg-456",
    };

    const action: ChatStateAction = {
      type: "START_BRANCH",
      payload: parentThread,
    };

    const newState = chatStateReducer(initialState, action);

    expect(newState.parentThread).toEqual(parentThread);
  });

  test("should clear branch context with CLEAR_BRANCH action", () => {
    const stateWithBranch: ChatState = {
      parentThread: {
        thread_id: "thread-123",
        messageId: "msg-456",
      },
      finishReason: null,
    };

    const action: ChatStateAction = { type: "CLEAR_BRANCH" };

    const newState = chatStateReducer(stateWithBranch, action);

    expect(newState.parentThread).toBeNull();
  });

  test("should set finish reason with SET_FINISH_REASON action", () => {
    const action: ChatStateAction = {
      type: "SET_FINISH_REASON",
      payload: "stop",
    };

    const newState = chatStateReducer(initialState, action);

    expect(newState.finishReason).toBe("stop");
    expect(newState.parentThread).toBeNull();
  });

  test("SET_FINISH_REASON returns same reference when payload is unchanged", () => {
    const stateWithReason: ChatState = {
      parentThread: null,
      finishReason: "stop",
    };

    const action: ChatStateAction = {
      type: "SET_FINISH_REASON",
      payload: "stop",
    };

    const newState = chatStateReducer(stateWithReason, action);

    expect(newState).toBe(stateWithReason);
  });

  test("should clear finish reason with CLEAR_FINISH_REASON action", () => {
    const stateWithFinishReason: ChatState = {
      parentThread: null,
      finishReason: "stop",
    };

    const action: ChatStateAction = { type: "CLEAR_FINISH_REASON" };

    const newState = chatStateReducer(stateWithFinishReason, action);

    expect(newState.finishReason).toBeNull();
  });

  test("should reset all state with RESET action", () => {
    const stateWithData: ChatState = {
      parentThread: {
        thread_id: "thread-123",
        messageId: "msg-456",
      },
      finishReason: "stop",
    };

    const action: ChatStateAction = { type: "RESET" };

    const newState = chatStateReducer(stateWithData, action);

    expect(newState.parentThread).toBeNull();
    expect(newState.finishReason).toBeNull();
  });

  test("should handle multiple sequential actions", () => {
    let state = initialState;

    const parentThread: ParentThread = {
      thread_id: "thread-1",
      messageId: "msg-1",
    };
    state = chatStateReducer(state, {
      type: "START_BRANCH",
      payload: parentThread,
    });
    expect(state.parentThread).toEqual(parentThread);

    state = chatStateReducer(state, { type: "CLEAR_BRANCH" });
    expect(state.parentThread).toBeNull();

    state = chatStateReducer(state, {
      type: "SET_FINISH_REASON",
      payload: "stop",
    });
    expect(state.finishReason).toBe("stop");

    state = chatStateReducer(state, { type: "RESET" });
    expect(state.parentThread).toBeNull();
    expect(state.finishReason).toBeNull();
  });

  test("should preserve state immutability", () => {
    const originalParentThread: ParentThread = {
      thread_id: "thread-1",
      messageId: "msg-1",
    };

    const originalState: ChatState = {
      parentThread: originalParentThread,
      finishReason: null,
    };

    const newState = chatStateReducer(originalState, { type: "CLEAR_BRANCH" });

    expect(originalParentThread.thread_id).toBe("thread-1");
    expect(originalState.parentThread).toEqual(originalParentThread);
    expect(newState.parentThread).toBeNull();
    expect(newState).not.toBe(originalState);
  });
});
