import { describe, expect, test } from "bun:test";
import * as queueNames from "./queue-names";

describe("DBOS queue names", () => {
  test("exports all run queues from the side-effect-free queue module", () => {
    expect(queueNames).toMatchObject({
      AUTOMATIONS_QUEUE: "automations",
      THREAD_GATE_QUEUE: "thread-gate",
      HOSTED_HARNESS_QUEUE: "decopilot-hosted-harness",
      HOSTED_HARNESS_SANDBOXED_QUEUE: "decopilot-hosted-harness-sandboxed",
      BACKGROUND_TOOLS_QUEUE: "background-tools",
      GITHUB_READS_QUEUE: "task-board-github-reads",
    });
    expect(queueNames).not.toHaveProperty("PROJECTOR_QUEUE");
  });
});
