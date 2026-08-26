import { describe, expect, mock, test } from "bun:test";
import {
  PREPARE_RUN_STATUS_STAGES,
  buildRunStatusChunk,
  isRunStatusControlChunk,
  isRunStatusChunk,
  publishRunStatusStage,
  shouldPublishRunStatus,
} from "./run-status-stage";

describe("buildRunStatusChunk", () => {
  test("builds a stage-only data-run-status chunk", () => {
    expect(buildRunStatusChunk("starting-run")).toEqual({
      type: "data-run-status",
      id: "run-status",
      data: { stage: "starting-run" },
    });
  });
});

describe("isRunStatusChunk", () => {
  test("matches valid run status chunks only", () => {
    expect(isRunStatusChunk(buildRunStatusChunk("preparing-tools"))).toBe(true);
    expect(isRunStatusChunk({ type: "data-run-status", data: {} })).toBe(false);
    expect(
      isRunStatusChunk({
        type: "data-run-status",
        data: { stage: "starting-run" },
      }),
    ).toBe(false);
    expect(
      isRunStatusChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "connecting-desktop" },
      }),
    ).toBe(false);
  });
});

describe("isRunStatusControlChunk", () => {
  test("matches any run-status control chunk, even unknown or malformed", () => {
    expect(
      isRunStatusControlChunk(buildRunStatusChunk("preparing-tools")),
    ).toBe(true);
    expect(
      isRunStatusControlChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "future-stage" },
      }),
    ).toBe(true);
    expect(isRunStatusControlChunk({ type: "data-run-status" })).toBe(true);
    expect(isRunStatusControlChunk({ type: "data-other" })).toBe(false);
  });
});

describe("publishRunStatusStage", () => {
  test("publishes through StreamBuffer when available", async () => {
    const publishRawChunk = mock(() => Promise.resolve(true));
    await publishRunStatusStage({
      streamBuffer: { publishRawChunk },
      harnessId: "decopilot",
      taskId: "thread-1",
      stage: "gathering-context",
    });
    expect(publishRawChunk).toHaveBeenCalledWith("thread-1", {
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
  });

  test("swallows publish failures", async () => {
    const publishRawChunk = mock(() => Promise.reject(new Error("nats down")));
    await expect(
      publishRunStatusStage({
        streamBuffer: { publishRawChunk },
        harnessId: "decopilot",
        taskId: "thread-1",
        stage: "starting-run",
      }),
    ).resolves.toBeUndefined();
  });

  test("is a no-op without a stream buffer", async () => {
    await expect(
      publishRunStatusStage({
        streamBuffer: undefined,
        harnessId: "decopilot",
        taskId: "thread-1",
        stage: "starting-run",
      }),
    ).resolves.toBeUndefined();
  });

  test("publishes for a sandbox-hosted run too", async () => {
    const publishRawChunk = mock(() => Promise.resolve(true));
    await publishRunStatusStage({
      streamBuffer: { publishRawChunk },
      harnessId: "claude-code",
      taskId: "thread-1",
      stage: "starting-sandbox",
    });
    expect(publishRawChunk).toHaveBeenCalledWith("thread-1", {
      type: "data-run-status",
      id: "run-status",
      data: { stage: "starting-sandbox" },
    });
  });

  test("publishes nothing for a harness that reports no status", async () => {
    const publishRawChunk = mock(() => Promise.resolve(true));
    await publishRunStatusStage({
      streamBuffer: { publishRawChunk },
      harnessId: "codex",
      taskId: "thread-1",
      stage: "starting-run",
    });
    expect(publishRawChunk).not.toHaveBeenCalled();
  });
});

describe("PREPARE_RUN_STATUS_STAGES", () => {
  test("lists the prepare run statuses in emission order", () => {
    expect(PREPARE_RUN_STATUS_STAGES).toEqual([
      "gathering-context",
      "preparing-tools",
      "starting-assistant",
      "analyzing-scope",
    ]);
  });
});

describe("shouldPublishRunStatus", () => {
  test("publishes for both hosted harnesses, nothing else", () => {
    expect(shouldPublishRunStatus("decopilot")).toBe(true);
    expect(shouldPublishRunStatus("claude-code")).toBe(true);
    expect(shouldPublishRunStatus("codex")).toBe(false);
    expect(shouldPublishRunStatus(null)).toBe(false);
    expect(shouldPublishRunStatus(undefined)).toBe(false);
  });
});
