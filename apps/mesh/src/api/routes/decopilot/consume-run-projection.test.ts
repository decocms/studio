import { describe, expect, it } from "bun:test";
import {
  classifyDrainMessage,
  consumeDurableName,
  isTerminalStatus,
} from "./consume-run-projection";

describe("isTerminalStatus", () => {
  it("is true for completed/failed/requires_action (run is over for the consumer)", () => {
    // The entry guard returns on these — consume already wrote them.
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("requires_action")).toBe(true);
    expect(isTerminalStatus("in_progress")).toBe(false);
  });
});

describe("consumeDurableName", () => {
  it("namespaces by runId", () => {
    expect(consumeDurableName("run_1")).toBe("decopilot-consume:run_1");
  });
});

describe("classifyDrainMessage", () => {
  const run = "run_1",
    fence = "fA";
  it("done for a valid same-fence done marker", () => {
    expect(
      classifyDrainMessage(
        { done: true, finalSeq: 10 },
        `${run}:${fence}:done:10`,
        run,
        fence,
      ),
    ).toBe("done");
  });
  it("checkpoint for a valid same-fence checkpoint", () => {
    expect(
      classifyDrainMessage(
        { checkpoint: true, headSeq: 5 },
        `${run}:${fence}:ckpt:5`,
        run,
        fence,
      ),
    ).toBe("checkpoint");
  });
  it("skip for a different fence (stale attempt)", () => {
    expect(
      classifyDrainMessage(
        { done: true, finalSeq: 10 },
        `${run}:OTHER:done:10`,
        run,
        fence,
      ),
    ).toBe("skip");
  });
  it("skip when envelope finalSeq disagrees with msgId", () => {
    expect(
      classifyDrainMessage(
        { done: true, finalSeq: 9 },
        `${run}:${fence}:done:10`,
        run,
        fence,
      ),
    ).toBe("skip");
  });
  it("skip for a plain chunk or missing msgId", () => {
    expect(
      classifyDrainMessage({ p: {} }, `${run}:${fence}:3`, run, fence),
    ).toBe("skip");
    expect(
      classifyDrainMessage({ done: true, finalSeq: 1 }, undefined, run, fence),
    ).toBe("skip");
  });
});
