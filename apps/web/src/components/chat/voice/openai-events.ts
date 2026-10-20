import { z } from "zod";
import {
  boundVoiceTranscript,
  VOICE_MAX_TEXT_LENGTH,
  type VoiceTranscript,
} from "@decocms/shared/voice";
import type { ConversationCallbacks, ConversationUpdate } from "./conversation";

const transcript = z.object({
  type: z.enum([
    "session.input_transcript.delta",
    "session.output_transcript.delta",
  ]),
  event_id: z.string(),
  delta: z.string(),
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
});
const delegation = z.object({
  type: z.literal("session.delegation.created"),
  offset_ms: z.number().nonnegative(),
  delegation: z.object({ id: z.string(), target: z.literal("client") }),
});
type Fragment = {
  role: "user" | "agent";
  text: string;
  start: number;
  end: number;
  arrivedAt: number;
  id: string;
};

/** Pure event state. Delegation, transcripts, and audio playback have independent lifecycles. */
export class OpenAIConversationEvents {
  private closed = false;
  private fragments: Fragment[] = [];
  private seen = new Set<string>();
  private delegated = new Set<string>();
  private consumed = new Set<string>();
  private pending = new Map<string, { offset: number; receivedAt: number }>();
  private contexts = new Map<string, string>();
  private awaitingContext = new Map<
    string,
    { remaining: Set<string>; delegationId?: string }
  >();

  constructor(
    private readonly send: (event: object) => void,
    private readonly callbacks: ConversationCallbacks,
  ) {}

  receive(raw: unknown, now = Date.now()) {
    if (this.closed) return;
    const text = transcript.safeParse(raw);
    if (text.success) {
      const event = text.data;
      if (this.seen.has(event.event_id)) return;
      this.seen.add(event.event_id);
      const role =
        event.type === "session.input_transcript.delta" ? "user" : "agent";
      this.fragments.push({
        role,
        text: event.delta,
        start: event.start_ms,
        end: event.end_ms,
        arrivedAt: now,
        id: event.event_id,
      });
      this.fragments.sort((a, b) => a.start - b.start);
      // The session is bounded to ten minutes. Fail rather than silently lose task context.
      if (this.fragments.length > 4000) {
        this.callbacks.onError();
        return;
      }
      this.callbacks.onMessage({
        role,
        message: event.delta,
        event_id: event.event_id,
      });
      return;
    }
    const request = delegation.safeParse(raw);
    if (request.success) {
      const { id } = request.data.delegation;
      if (this.delegated.has(id) || this.pending.has(id)) return;
      if (this.delegated.size + this.pending.size >= 40) {
        this.callbacks.onError();
        return;
      }
      this.pending.set(id, { offset: request.data.offset_ms, receivedAt: now });
      return;
    }
    const acknowledged = z
      .object({
        type: z.literal("session.thinking.appended"),
        client_event_id: z.string(),
      })
      .safeParse(raw);
    if (acknowledged.success) {
      const id = acknowledged.data.client_event_id;
      const group = this.awaitingContext.get(id);
      this.awaitingContext.delete(id);
      if (group) {
        group.remaining.delete(id);
        if (group.remaining.size === 0)
          this.send({
            type: "session.commentary.append",
            event_id: crypto.randomUUID(),
            delegation_id: group.delegationId ?? null,
            content:
              "Studio has supplied the complete background result as context for this request. Briefly explain that result, including any failure or required approval. Acceptance or task creation alone does not mean the work completed.",
          });
      }
      return;
    }
    const event = z.object({ type: z.string() }).safeParse(raw);
    if (event.success && event.data.type === "error") this.callbacks.onError();
  }

  /** Allow delayed transcript fragments to catch up; a fragment alone never starts work. */
  tick(now = Date.now()) {
    if (this.closed) return;
    for (const [id, pending] of this.pending) {
      const context = this.fragments.filter(
        (part) => part.start < pending.offset,
      );
      const lastRelevantTranscript = context.reduce(
        (latest, part) =>
          part.role === "user" ? Math.max(latest, part.arrivedAt) : latest,
        pending.receivedAt,
      );
      if (now - lastRelevantTranscript < 500) continue;
      const fresh = context.filter(
        (part) => part.role === "user" && !this.consumed.has(part.id),
      );
      if (!fresh.length && now - pending.receivedAt < 3000) continue;
      this.pending.delete(id);
      this.delegated.add(id);
      if (!fresh.length) {
        this.publishUpdate({
          delivery: "announce",
          delegationId: id,
          text: "No new transcribed request is available. No work was started. Ask the user to repeat the request.",
        });
        continue;
      }
      const request = fresh
        .map((part) => part.text)
        .join("")
        .trim();
      // Transcript deltas are word-sized; merge them into turns.
      const transcript: VoiceTranscript = [];
      for (const part of context) {
        if (fresh.includes(part)) continue;
        const last = transcript.at(-1);
        if (last?.role === part.role) last.text += part.text;
        else transcript.push({ role: part.role, text: part.text });
      }
      if (request.length > VOICE_MAX_TEXT_LENGTH) {
        this.publishUpdate({
          delivery: "announce",
          delegationId: id,
          text: "The spoken request is too long. No work was started. Ask the user to shorten it or continue in text.",
        });
        continue;
      }
      for (const part of fresh) this.consumed.add(part.id);
      void this.callbacks
        .onDelegate({
          request,
          delegationId: id,
          transcript: boundVoiceTranscript(
            transcript
              .map(({ role, text }) => ({ role, text: text.trim() }))
              .filter(({ text }) => text),
          ),
        })
        .then((receipt) => {
          if (this.closed) return;
          this.publishUpdate({
            delivery: receipt.status === "rejected" ? "announce" : "context",
            delegationId: id,
            text: JSON.stringify(receipt),
          });
        })
        .catch(() => {
          this.publishUpdate({
            delivery: "announce",
            delegationId: id,
            text: "Studio could not accept this request. Do not claim work started.",
          });
        });
    }
  }

  publishUpdate(update: ConversationUpdate) {
    if (this.closed) return;
    if (update.contextId) {
      if (this.contexts.get(update.contextId) === update.text) return;
      this.contexts.set(update.contextId, update.text);
    }
    // Each UTF-8 byte is an upper bound on a byte-tokenizer token. Stay below
    // Live's 500-token append limit without loading a tokenizer in the browser.
    const prefix = update.contextId
      ? `Updated ${update.contextId} data, superseding earlier values:\n`
      : "Studio result data:\n";
    const text = prefix + update.text;
    const encoder = new TextEncoder();
    const deferredAnnouncement =
      update.delivery === "announce" && encoder.encode(text).length > 480;
    const group = {
      remaining: new Set<string>(),
      delegationId: update.delegationId,
    };
    let chunk = "";
    let bytes = 0;
    const emit = () => {
      if (!chunk) return;
      const eventId = crypto.randomUUID();
      if (deferredAnnouncement) {
        group.remaining.add(eventId);
        this.awaitingContext.set(eventId, group);
      }
      this.send({
        type:
          update.delivery === "announce" && !deferredAnnouncement
            ? "session.commentary.append"
            : "session.thinking.append",
        event_id: eventId,
        delegation_id: update.delegationId ?? null,
        content: chunk,
      });
      chunk = "";
      bytes = 0;
    };
    for (const character of text) {
      const size = encoder.encode(character).length;
      if (bytes + size > 480) emit();
      chunk += character;
      bytes += size;
    }
    emit();
  }

  close() {
    this.closed = true;
    this.pending.clear();
    this.awaitingContext.clear();
  }
}
