import { describe, expect, test } from "bun:test";
import type { JetStreamClient } from "@nats-io/jetstream";
import { createDirectNatsPublisher } from "./direct-nats-publisher";

describe("createDirectNatsPublisher", () => {
  test("publishes relay chunks and done marker with deterministic msg ids", async () => {
    const published: Array<{
      subject: string;
      payload: unknown;
      msgID?: string;
    }> = [];
    const js = {
      publish: async (
        subject: string,
        data: Uint8Array,
        opts?: { msgID?: string },
      ) => {
        published.push({
          subject,
          payload: JSON.parse(new TextDecoder().decode(data)),
          msgID: opts?.msgID,
        });
        return {} as never;
      },
    } as Pick<JetStreamClient, "publish">;

    const publisher = createDirectNatsPublisher({ js });
    await publisher.publishLine({
      runId: "run_1",
      fenceToken: "fence_1",
      line: {
        seq: 1,
        event: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "1", delta: "hi" },
        },
      },
    });
    await publisher.publishDone({
      runId: "run_1",
      fenceToken: "fence_1",
      finalSeq: 1,
    });

    expect(published).toEqual([
      {
        subject: "decopilot.stream.run_1",
        payload: { p: { type: "text-delta", id: "1", delta: "hi" } },
        msgID: "run_1:fence_1:1",
      },
      {
        subject: "decopilot.stream.run_1",
        payload: { done: true, finalSeq: 1 },
        msgID: "run_1:fence_1:done:1",
      },
    ]);
  });
});
