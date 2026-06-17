import type { UIMessageChunk } from "ai";
import { AckPolicy, DeliverPolicy, type JetStreamClient } from "nats";
import {
  isDoneEnvelope,
  parseRunStreamMsgId,
  runIdFromSubject,
  streamSubject,
} from "./projector-stream-messages";

const FRAG_INDEX_HEADER = "Dp-Frag-Idx";
const FRAG_TOTAL_HEADER = "Dp-Frag-Total";

export interface ProjectorRetainedMessage {
  subject: string;
  msgId?: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
}

export type ReconstructResult =
  | { ok: true; chunks: UIMessageChunk[]; chunkCount: number }
  | { ok: false; error: string };

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodePayload(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

export function reconstructProjectorRun(input: {
  runId: string;
  fenceToken: string;
  finalSeq: number;
  messages: ProjectorRetainedMessage[];
}): ReconstructResult {
  const chunks = new Map<number, UIMessageChunk>();
  const fragments = new Map<number, { total: number; parts: Uint8Array[] }>();
  let sawDone = false;

  for (const message of input.messages) {
    if (runIdFromSubject(message.subject) !== input.runId) continue;
    const parsed = parseRunStreamMsgId(message.msgId);
    if (
      !parsed ||
      parsed.runId !== input.runId ||
      parsed.fenceToken !== input.fenceToken
    ) {
      continue;
    }

    if (parsed.kind === "done") {
      const payload = decodePayload(message.data);
      if (parsed.finalSeq === input.finalSeq && isDoneEnvelope(payload)) {
        sawDone = true;
      }
      continue;
    }

    if (parsed.seq > input.finalSeq) continue;
    const total = Number(message.headers?.get(FRAG_TOTAL_HEADER) ?? "0");
    if (parsed.fragmentIndex !== null || total > 0) {
      const index =
        parsed.fragmentIndex ??
        Number(message.headers?.get(FRAG_INDEX_HEADER) ?? "0");
      const existing = fragments.get(parsed.seq) ?? {
        total,
        parts: new Array(total),
      };
      existing.parts[index] = message.data;
      fragments.set(parsed.seq, existing);
      if (existing.parts.filter(Boolean).length === existing.total) {
        const payload = decodePayload(concat(existing.parts));
        if (payload && typeof payload === "object" && "p" in payload) {
          chunks.set(parsed.seq, (payload as { p: UIMessageChunk }).p);
        }
      }
      continue;
    }

    const payload = decodePayload(message.data);
    if (payload && typeof payload === "object" && "p" in payload) {
      chunks.set(parsed.seq, (payload as { p: UIMessageChunk }).p);
    }
  }

  if (!sawDone) return { ok: false, error: "missing done" };
  const out: UIMessageChunk[] = [];
  for (let seq = 1; seq <= input.finalSeq; seq++) {
    const chunk = chunks.get(seq);
    if (!chunk) return { ok: false, error: `missing seq ${seq}` };
    out.push(chunk);
  }
  return { ok: true, chunks: out, chunkCount: out.length };
}

export async function readProjectorRunLog(input: {
  js: JetStreamClient;
  runId: string;
  fenceToken: string;
  finalSeq: number;
  idleTimeoutMs?: number;
}): Promise<ReconstructResult> {
  const sub = await input.js.subscribe(streamSubject(input.runId), {
    ordered: true,
    config: {
      filter_subject: streamSubject(input.runId),
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.All,
    },
  });
  const messages: ProjectorRetainedMessage[] = [];
  const idleTimeoutMs = input.idleTimeoutMs ?? 1000;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      sub.unsubscribe();
    }, idleTimeoutMs);
    idle.unref?.();
  };

  try {
    resetIdle();
    for await (const m of sub) {
      resetIdle();
      messages.push({
        subject: m.subject,
        data: m.data,
        msgId: m.headers?.get("Nats-Msg-Id") || undefined,
        headers: m.headers,
      });
      const current = reconstructProjectorRun({
        runId: input.runId,
        fenceToken: input.fenceToken,
        finalSeq: input.finalSeq,
        messages,
      });
      if (current.ok) {
        sub.unsubscribe();
        return current;
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }

  return timedOut
    ? reconstructProjectorRun({
        runId: input.runId,
        fenceToken: input.fenceToken,
        finalSeq: input.finalSeq,
        messages,
      })
    : { ok: false, error: "reader stopped before done" };
}
