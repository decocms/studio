import { jetstream, StorageType } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { nanos, type NatsConnection } from "@nats-io/nats-core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { VOICE_SESSION_TTL_MS } from "@decocms/shared/voice";
import { sleep } from "@decocms/shared/std";
import type { ConversationAdapter } from "./types";
import type { ElevenLabsSpeechAdapter } from "./elevenlabs";

const codec = new TextEncoder();
const AgentReservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), agentId: z.string() }),
  z.object({ state: z.literal("creating"), expiresAt: z.number() }),
]);

export class ElevenLabsConversationAdapter implements ConversationAdapter {
  private kvPromise?: Promise<KV>;
  constructor(
    private readonly adapter: ElevenLabsSpeechAdapter,
    private readonly getConnection: () => NatsConnection | null,
  ) {}

  private kv(): Promise<KV> {
    const nc = this.getConnection();
    if (!nc || nc.isClosed())
      throw new HTTPException(503, {
        message: "Voice transport is unavailable",
      });
    this.kvPromise ??= new Kvm(jetstream(nc))
      .create("STUDIO_VOICE_SESSIONS", {
        storage: StorageType.Memory,
        ttl: nanos(VOICE_SESSION_TTL_MS),
        max_bytes: 10 * 1024 * 1024,
      })
      .catch((error) => {
        this.kvPromise = undefined;
        throw error;
      });
    return this.kvPromise;
  }

  private async conversationAgent(): Promise<string> {
    const adapter = this.adapter;
    const kv = await this.kv();
    const key = `agent.${adapter.conversationKey}`;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const entry = await kv.get(key);
      const value =
        entry?.operation === "PUT"
          ? AgentReservationSchema.parse(entry.json())
          : null;
      if (value?.state === "ready") return value.agentId;
      if (value?.state === "creating" && value.expiresAt > Date.now()) {
        await sleep(200);
        continue;
      }
      const lease = codec.encode(
        JSON.stringify({ state: "creating", expiresAt: Date.now() + 40_000 }),
      );
      let revision: number;
      try {
        revision =
          entry && value
            ? await kv.update(key, lease, entry.revision)
            : await kv.create(key, lease);
      } catch {
        await sleep(200);
        continue;
      }
      try {
        const agentId = await adapter.ensureConversationAgent();
        await kv.update(
          key,
          codec.encode(JSON.stringify({ state: "ready", agentId })),
          revision,
        );
        return agentId;
      } catch (error) {
        await kv.delete(key, { previousSeq: revision }).catch(() => {});
        throw error;
      }
    }
    throw new HTTPException(503, {
      message: "Voice conversation is starting; try again",
    });
  }

  async createSession() {
    const agentId = await this.conversationAgent();
    try {
      return {
        provider: "elevenlabs" as const,
        conversationToken: await this.adapter.createConversationToken(agentId),
      };
    } catch (error) {
      // A removed or inaccessible provider agent must not poison later sessions.
      const kv = await this.kv();
      const key = `agent.${this.adapter.conversationKey}`;
      const entry = await kv.get(key);
      const value =
        entry?.operation === "PUT"
          ? AgentReservationSchema.parse(entry.json())
          : null;
      if (entry && value?.state === "ready" && value.agentId === agentId) {
        await kv.delete(key, { previousSeq: entry.revision }).catch(() => {});
      }
      throw error;
    }
  }
}
