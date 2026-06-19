import { describe, expect, test } from "bun:test";

describe("DBOS worker queue selection", () => {
  test("worker role listens to all run queues, including the durable projector", async () => {
    const source = await Bun.file(
      new URL("./index.ts", import.meta.url),
    ).text();

    expect(source).toContain("PROJECTOR_QUEUE");
    expect(source).toContain(
      "const RUN_QUEUES = [AUTOMATIONS_QUEUE, THREAD_GATE_QUEUE, PROJECTOR_QUEUE]",
    );
  });
});
