/**
 * A manual fire (Run, Re-run, delegation, retry, conflict fix) skips the
 * column gates but must still refuse a card that already has a run going —
 * `eventKey` is random per call, so nothing else dedupes a resubmitted
 * request into one dispatch.
 */

import { describe, expect, it } from "bun:test";
import { hasLiveThread } from "./card-run";
import type { TaskBoardItem, TaskBoardItemThreadRef } from "@/storage/types";

function thread(
  partial: Partial<TaskBoardItemThreadRef>,
): TaskBoardItemThreadRef {
  return {
    threadId: "t1",
    virtualMcpId: null,
    status: "completed",
    title: null,
    lastMessage: null,
    hasPreview: false,
    failureKind: null,
    hasMessages: true,
    lastActiveAt: new Date().toISOString(),
    costUsd: null,
    costProvider: null,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function item(threads: TaskBoardItemThreadRef[]): TaskBoardItem {
  return { threads } as TaskBoardItem;
}

describe("hasLiveThread", () => {
  it("is true for an in-progress thread with messages", () => {
    expect(hasLiveThread(item([thread({ status: "in_progress" })]))).toBe(true);
  });

  it("is true for a thread waiting on required action", () => {
    expect(hasLiveThread(item([thread({ status: "requires_action" })]))).toBe(
      true,
    );
  });

  it("ignores an in-progress thread that never got a message", () => {
    expect(
      hasLiveThread(
        item([thread({ status: "in_progress", hasMessages: false })]),
      ),
    ).toBe(false);
  });

  it("is false once every thread is terminal", () => {
    expect(
      hasLiveThread(
        item([thread({ status: "completed" }), thread({ status: "failed" })]),
      ),
    ).toBe(false);
  });

  it("is false for a card with no threads", () => {
    expect(hasLiveThread(item([]))).toBe(false);
  });
});
