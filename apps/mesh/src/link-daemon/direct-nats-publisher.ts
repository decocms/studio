import type { JetStreamClient } from "@nats-io/jetstream";
import type { RelayLine } from "../links/protocol/relay";
import {
  buildChunkMsgId,
  buildDoneMsgId,
  streamSubject,
} from "../api/routes/decopilot/projector-stream-messages";

export interface DirectNatsPublisher {
  publishLine(input: {
    runId: string;
    fenceToken: string;
    line: RelayLine;
  }): Promise<"published" | "terminal">;
  publishDone(input: {
    runId: string;
    fenceToken: string;
    finalSeq: number;
  }): Promise<void>;
}

export function createDirectNatsPublisher(input: {
  js: Pick<JetStreamClient, "publish">;
}): DirectNatsPublisher {
  const encoder = new TextEncoder();
  return {
    async publishLine({ runId, fenceToken, line }) {
      if (line.event.type !== "ui-message-chunk") {
        return "terminal";
      }
      await input.js.publish(
        streamSubject(runId),
        encoder.encode(JSON.stringify({ p: line.event.chunk })),
        { msgID: buildChunkMsgId({ runId, fenceToken, seq: line.seq }) },
      );
      return "published";
    },
    async publishDone({ runId, fenceToken, finalSeq }) {
      await input.js.publish(
        streamSubject(runId),
        encoder.encode(JSON.stringify({ done: true, finalSeq })),
        { msgID: buildDoneMsgId({ runId, fenceToken, finalSeq }) },
      );
    },
  };
}
