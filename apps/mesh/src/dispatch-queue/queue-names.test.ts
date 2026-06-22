import { describe, expect, test } from "bun:test";
import * as queueNames from "./queue-names";

describe("DBOS queue names", () => {
  test("exports the projector queue from the side-effect-free queue module", () => {
    expect(queueNames).toMatchObject({
      AUTOMATIONS_QUEUE: "automations",
      THREAD_GATE_QUEUE: "thread-gate",
      PROJECTOR_QUEUE: "decopilot-projector",
    });
  });
});
