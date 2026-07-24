import { describe, expect, mock, test } from "bun:test";
import {
  PREPARE_RUN_STATUS_STAGES,
  buildRunStatusChunk,
  isRunStatusControlChunk,
  isRunStatusChunk,
  publishRunStatusStage,
  shouldPublishClusterRunStatus,
  shouldPublishThreadGateRunStatus,
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
    await publishRunStatusStage(
      {
        publishRawChunk,
      },
      "thread-1",
      "gathering-context",
    );
    expect(publishRawChunk).toHaveBeenCalledWith("thread-1", {
      type: "data-run-status",
      id: "run-status",
      data: { stage: "gathering-context" },
    });
  });

  test("swallows publish failures", async () => {
    const publishRawChunk = mock(() => Promise.reject(new Error("nats down")));
    await expect(
      publishRunStatusStage({ publishRawChunk }, "thread-1", "starting-run"),
    ).resolves.toBeUndefined();
  });

  test("is a no-op without a stream buffer", async () => {
    await expect(
      publishRunStatusStage(undefined, "thread-1", "starting-run"),
    ).resolves.toBeUndefined();
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

describe("shouldPublishClusterRunStatus", () => {
  test("only publishes for decopilot runs in the agent sandbox", () => {
    expect(
      shouldPublishClusterRunStatus({
        sandboxProviderKind: "agent-sandbox",
        harnessId: "decopilot",
      }),
    ).toBe(true);

    expect(
      shouldPublishClusterRunStatus({
        sandboxProviderKind: "user-desktop",
        harnessId: "decopilot",
      }),
    ).toBe(false);
    expect(
      shouldPublishClusterRunStatus({
        sandboxProviderKind: "agent-sandbox",
        harnessId: "claude-code",
      }),
    ).toBe(false);
    expect(
      shouldPublishClusterRunStatus({
        sandboxProviderKind: "agent-sandbox",
        harnessId: "codex",
      }),
    ).toBe(false);
    expect(
      shouldPublishClusterRunStatus({
        sandboxProviderKind: "agent-sandbox",
      }),
    ).toBe(false);
    expect(
      shouldPublishClusterRunStatus({
        harnessId: "decopilot",
      }),
    ).toBe(false);
  });
});

describe("shouldPublishThreadGateRunStatus", () => {
  test("publishes for decopilot hosted and legacy runs only", () => {
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "agent-sandbox",
        harnessId: "decopilot",
      }),
    ).toBe(true);
    expect(
      shouldPublishThreadGateRunStatus({
        harnessId: "decopilot",
      }),
    ).toBe(true);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: null,
        harnessId: "decopilot",
      }),
    ).toBe(true);

    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "user-desktop",
        harnessId: "decopilot",
      }),
    ).toBe(false);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "other-provider-kind",
        harnessId: "decopilot",
      }),
    ).toBe(false);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "agent-sandbox",
        harnessId: "claude-code",
      }),
    ).toBe(false);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "user-desktop",
        harnessId: "claude-code",
      }),
    ).toBe(false);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "agent-sandbox",
        harnessId: "codex",
      }),
    ).toBe(false);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "user-desktop",
        harnessId: "codex",
      }),
    ).toBe(false);
    expect(
      shouldPublishThreadGateRunStatus({
        sandboxProviderKind: "agent-sandbox",
      }),
    ).toBe(false);
    expect(shouldPublishThreadGateRunStatus({})).toBe(false);
  });
});
