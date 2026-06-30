import { describe, expect, test } from "bun:test";
import * as queueNames from "./queue-names";

describe("DBOS queue names", () => {
  test("exports all run queues from the side-effect-free queue module", () => {
    expect(queueNames).toMatchObject({
      AUTOMATIONS_QUEUE: "automations",
      THREAD_GATE_QUEUE: "thread-gate",
      HOSTED_HARNESS_QUEUE: "decopilot-hosted-harness",
      BACKGROUND_TOOLS_QUEUE: "background-tools",
    });
    expect(queueNames).not.toHaveProperty("PROJECTOR_QUEUE");
  });
});
