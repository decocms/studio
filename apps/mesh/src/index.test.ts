import { describe, expect, test } from "bun:test";

describe("DBOS worker queue selection", () => {
  test("worker role listens to all run queues, including the hosted-harness child workflow", async () => {
    const source = await Bun.file(
      new URL("./index.ts", import.meta.url),
    ).text();

    // Match the RUN_QUEUES array literal and assert membership, rather than an
    // exact one-line form — survives reformatting and added queues.
    const runQueues = source.match(/const RUN_QUEUES = \[([\s\S]*?)\]/)?.[1];
    expect(runQueues).toBeDefined();
    for (const queue of [
      "AUTOMATIONS_QUEUE",
      "THREAD_GATE_QUEUE",
      "HOSTED_HARNESS_QUEUE",
      "BACKGROUND_TOOLS_QUEUE",
    ]) {
      expect(runQueues).toContain(queue);
    }
    expect(runQueues).not.toContain("PROJECTOR_QUEUE");
  });
});
