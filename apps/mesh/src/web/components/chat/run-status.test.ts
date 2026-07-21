import { describe, expect, test } from "bun:test";
import {
  RUN_STATUS_COPY,
  advanceRunStatusStage,
  isRunStatusControlChunk,
  parseRunStatusStageChunk,
  RUN_STATUS_STAGE_ORDER,
} from "./run-status";

describe("run status copy", () => {
  test("has user-facing copy for every ordered stage", () => {
    for (const stage of RUN_STATUS_STAGE_ORDER) {
      expect(RUN_STATUS_COPY[stage].label.length).toBeGreaterThan(0);
      expect(RUN_STATUS_COPY[stage].detail.length).toBeGreaterThan(0);
    }
  });

  test("uses plain, user-friendly copy", () => {
    expect(RUN_STATUS_COPY["waiting-runner"]).toEqual({
      label: "Waiting to start",
      detail: "Finishing up the previous message in this chat",
    });
    expect(RUN_STATUS_COPY["analyzing-scope"]).toEqual({
      label: "Thinking",
      detail: "Working out how to respond",
    });
  });
});

describe("parseRunStatusStageChunk", () => {
  test("extracts a valid data-run-status stage", () => {
    expect(
      parseRunStatusStageChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "gathering-context" },
      }),
    ).toBe("gathering-context");
  });

  test("returns null for unknown or malformed chunks", () => {
    expect(parseRunStatusStageChunk({ type: "text-delta" })).toBeNull();
    expect(
      parseRunStatusStageChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "connecting-desktop" },
      }),
    ).toBeNull();
    expect(
      parseRunStatusStageChunk({
        type: "data-run-status",
        id: "run-status",
        data: {},
      }),
    ).toBeNull();
  });
});

describe("isRunStatusControlChunk", () => {
  test("matches any run-status control chunk, even unknown or malformed", () => {
    expect(
      isRunStatusControlChunk({
        type: "data-run-status",
        id: "run-status",
        data: { stage: "gathering-context" },
      }),
    ).toBe(true);
    expect(
      isRunStatusControlChunk({
        type: "data-run-status",
        data: { stage: "future-stage" },
      }),
    ).toBe(true);
    expect(isRunStatusControlChunk({ type: "data-run-status" })).toBe(true);
    expect(isRunStatusControlChunk({ type: "data-other" })).toBe(false);
  });
});

describe("advanceRunStatusStage", () => {
  test("advances forward and ignores replayed older stages", () => {
    let current = advanceRunStatusStage(null, "received");
    expect(current).toBe("received");
    current = advanceRunStatusStage(current, "gathering-context");
    expect(current).toBe("gathering-context");
    current = advanceRunStatusStage(current, "starting-run");
    expect(current).toBe("gathering-context");
  });

  test("allows repeated stages", () => {
    expect(advanceRunStatusStage("preparing-tools", "preparing-tools")).toBe(
      "preparing-tools",
    );
  });
});
