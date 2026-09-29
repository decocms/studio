import { createHash } from "node:crypto";
import { jetstream, StorageType } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import { nanos, type NatsConnection } from "@nats-io/nats-core";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { VOICE_SESSION_TTL_MS } from "@decocms/shared/voice";
import { sleep } from "@decocms/shared/std";
import type { SpeechAdapter } from "@/ai-providers/voice/types";
import { signVoiceGrant, verifyVoiceGrant, type VoiceClaims } from "./grant";

type Scope = Omit<VoiceClaims, "sessionId" | "expiresAt">;
const ReservationSchema = z.object({
  sessionId: z.string().uuid(),
  expiresAt: z.number(),
  characters: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
});
const codec = new TextEncoder();
const AgentReservationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), agentId: z.string() }),
  z.object({ state: z.literal("creating"), expiresAt: z.number() }),
]);
function userKey(scope: Scope) {
  return `user.${createHash("sha256")
    .update(JSON.stringify([scope.organizationId, scope.userId]))
    .digest("hex")}`;
}

/** Shared reservations bound speech usage across API replicas. */
export class VoiceSessions {
  private kvPromise?: Promise<KV>;

  constructor(
    private readonly deps: {
      adapter: SpeechAdapter | null;
      secret: string;
      getConnection: () => NatsConnection | null;
    },
  ) {}

  private kv(): Promise<KV> {
    const nc = this.deps.getConnection();
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

  private adapter() {
    if (!this.deps.adapter)
      throw new HTTPException(503, {
        message: "Voice is not configured on this deployment",
      });
    return this.deps.adapter;
  }

  private async conversationAgent(): Promise<string> {
    const adapter = this.adapter();
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

  async create(scope: Scope, conversation = false) {
    const adapter = this.adapter();
    const claims: VoiceClaims = {
      ...scope,
      sessionId: crypto.randomUUID(),
      expiresAt: Date.now() + VOICE_SESSION_TTL_MS,
    };
    const token = signVoiceGrant(claims, this.deps.secret);
    const kv = await this.kv();
    const key = userKey(claims);
    const entry = await kv.get(key);
    const previous =
      entry?.operation === "PUT" ? ReservationSchema.parse(entry.json()) : null;
    const value = codec.encode(
      JSON.stringify({
        sessionId: claims.sessionId,
        expiresAt: claims.expiresAt,
        characters: 0,
        requests: 0,
      }),
    );
    try {
      if (entry && previous && previous.expiresAt <= Date.now()) {
        await kv.update(key, value, entry.revision);
      } else {
        await kv.create(key, value);
      }
    } catch {
      throw new HTTPException(409, {
        message: "Close your other voice session before starting a new one",
      });
    }
    try {
      if (conversation) {
        const agentId = await this.conversationAgent();
        try {
          const conversationToken =
            await adapter.createConversationToken(agentId);
          return { token, conversationToken, expiresAt: claims.expiresAt };
        } catch (error) {
          // A removed or inaccessible provider resource must not poison later sessions.
          const key = `agent.${adapter.conversationKey}`;
          const entry = await kv.get(key);
          const value =
            entry?.operation === "PUT"
              ? AgentReservationSchema.parse(entry.json())
              : null;
          if (entry && value?.state === "ready" && value.agentId === agentId) {
            await kv
              .delete(key, { previousSeq: entry.revision })
              .catch(() => {});
          }
          throw error;
        }
      }
      const transcriptionToken = await adapter.createTranscriptionToken();
      return { token, transcriptionToken, expiresAt: claims.expiresAt };
    } catch (error) {
      await this.release(claims);
      throw error;
    }
  }

  private authorize(scope: Scope, token: string) {
    const claims = verifyVoiceGrant(token, this.deps.secret);
    if (
      !claims ||
      claims.organizationId !== scope.organizationId ||
      claims.userId !== scope.userId ||
      claims.threadId !== scope.threadId
    ) {
      throw new HTTPException(403, { message: "Invalid voice session" });
    }
    return claims;
  }

  async speak(scope: Scope, token: string, text: string, signal: AbortSignal) {
    const claims = this.authorize(scope, token);
    const kv = await this.kv();
    const key = userKey(claims);
    // Charge before dispatch. Retries and simultaneous requests consume the same allowance.
    for (let attempt = 0; ; attempt++) {
      const entry = await kv.get(key);
      const value =
        entry?.operation === "PUT"
          ? ReservationSchema.parse(entry.json())
          : null;
      if (
        !entry ||
        !value ||
        value.sessionId !== claims.sessionId ||
        value.expiresAt <= Date.now()
      )
        throw new HTTPException(403, { message: "Voice session expired" });
      if (value.characters + text.length > 24_000 || value.requests >= 120)
        throw new HTTPException(429, {
          message: "Voice session speech limit reached",
        });
      try {
        await kv.update(
          key,
          codec.encode(
            JSON.stringify({
              ...value,
              characters: value.characters + text.length,
              requests: value.requests + 1,
            }),
          ),
          entry.revision,
        );
        break;
      } catch {
        if (attempt >= 2)
          throw new HTTPException(409, { message: "Voice session is busy" });
      }
    }
    return this.adapter().synthesize(text, signal);
  }

  private async release(claims: VoiceClaims): Promise<void> {
    const kv = await this.kv();
    const entry = await kv.get(userKey(claims));
    if (
      entry?.operation === "PUT" &&
      ReservationSchema.parse(entry.json()).sessionId === claims.sessionId
    ) {
      await kv.delete(userKey(claims), { previousSeq: entry.revision });
    }
  }

  async revoke(scope: Scope, token: string) {
    await this.release(this.authorize(scope, token));
  }
}
