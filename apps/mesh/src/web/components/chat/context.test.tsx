/**
 * Tests for ChatState Reducer
 *
 * Tests the reducer logic for the chat state management.
 * NOTE: tiptapDoc was moved out of the reducer into ChatInput local state.
 */

import { describe, expect, test } from "bun:test";
import type { ParentTask } from "./types.ts";
import {
  chatStateReducer,
  type ChatState,
  type ChatStateAction,
} from "./chat-state";

describe("ChatState Reducer Logic", () => {
  const initialState: ChatState = {
    parentTask: null,
    finishReason: null,
  };

  test("should initialize with empty state", () => {
    expect(initialState.parentTask).toBeNull();
    expect(initialState.finishReason).toBeNull();
  });

  test("should start branch with START_BRANCH action", () => {
    const parentTask: ParentTask = {
      thread_id: "thread-123",
      messageId: "msg-456",
    };

    const action: ChatStateAction = {
      type: "START_BRANCH",
      payload: parentTask,
    };

    const newState = chatStateReducer(initialState, action);

    expect(newState.parentTask).toEqual(parentTask);
  });

  test("should clear branch context with CLEAR_BRANCH action", () => {
    const stateWithBranch: ChatState = {
      parentTask: {
        thread_id: "thread-123",
        messageId: "msg-456",
      },
      finishReason: null,
    };

    const action: ChatStateAction = { type: "CLEAR_BRANCH" };

    const newState = chatStateReducer(stateWithBranch, action);

    expect(newState.parentTask).toBeNull();
  });

  test("should set finish reason with SET_FINISH_REASON action", () => {
    const action: ChatStateAction = {
      type: "SET_FINISH_REASON",
      payload: "stop",
    };

    const newState = chatStateReducer(initialState, action);

    expect(newState.finishReason).toBe("stop");
    expect(newState.parentTask).toBeNull();
  });

  test("SET_FINISH_REASON returns same reference when payload is unchanged", () => {
    const stateWithReason: ChatState = {
      parentTask: null,
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
      parentTask: null,
      finishReason: "stop",
    };

    const action: ChatStateAction = { type: "CLEAR_FINISH_REASON" };

    const newState = chatStateReducer(stateWithFinishReason, action);

    expect(newState.finishReason).toBeNull();
  });

  test("should reset all state with RESET action", () => {
    const stateWithData: ChatState = {
      parentTask: {
        thread_id: "thread-123",
        messageId: "msg-456",
      },
      finishReason: "stop",
    };

    const action: ChatStateAction = { type: "RESET" };

    const newState = chatStateReducer(stateWithData, action);

    expect(newState.parentTask).toBeNull();
    expect(newState.finishReason).toBeNull();
  });

  test("should handle multiple sequential actions", () => {
    let state = initialState;

    const parentTask: ParentTask = {
      thread_id: "thread-1",
      messageId: "msg-1",
    };
    state = chatStateReducer(state, {
      type: "START_BRANCH",
      payload: parentTask,
    });
    expect(state.parentTask).toEqual(parentTask);

    state = chatStateReducer(state, { type: "CLEAR_BRANCH" });
    expect(state.parentTask).toBeNull();

    state = chatStateReducer(state, {
      type: "SET_FINISH_REASON",
      payload: "stop",
    });
    expect(state.finishReason).toBe("stop");

    state = chatStateReducer(state, { type: "RESET" });
    expect(state.parentTask).toBeNull();
    expect(state.finishReason).toBeNull();
  });

  test("should preserve state immutability", () => {
    const originalParentTask: ParentTask = {
      thread_id: "thread-1",
      messageId: "msg-1",
    };

    const originalState: ChatState = {
      parentTask: originalParentTask,
      finishReason: null,
    };

    const newState = chatStateReducer(originalState, { type: "CLEAR_BRANCH" });

    expect(originalParentTask.thread_id).toBe("thread-1");
    expect(originalState.parentTask).toEqual(originalParentTask);
    expect(newState.parentTask).toBeNull();
    expect(newState).not.toBe(originalState);
  });
});
