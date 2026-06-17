import { describe, expect, mock, test } from "bun:test";
import {
  buildRunStatusChunk,
  isRunStatusChunk,
  publishRunStatusStage,
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
