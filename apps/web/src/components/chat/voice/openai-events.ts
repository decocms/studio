import { z } from "zod";
import type { ConversationCallbacks } from "./conversation";

const functionCall = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string().max(64_000),
});
const serverEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_audio_buffer.speech_started") }),
  z.object({ type: z.literal("input_audio_buffer.speech_stopped") }),
  z.object({
    type: z.literal("input_audio_buffer.committed"),
    item_id: z.string(),
  }),
  z.object({
    type: z.literal("conversation.item.input_audio_transcription.completed"),
    item_id: z.string(),
    transcript: z.string(),
  }),
  z.object({
    type: z.literal("response.created"),
    response: z.object({ id: z.string() }),
  }),
  z.object({
    type: z.literal("response.done"),
    response: z.object({
      id: z.string(),
      status: z.string(),
      output: z.array(z.unknown()).default([]),
    }),
  }),
  z.object({
    type: z.literal("response.output_audio_transcript.delta"),
    item_id: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("response.output_audio_transcript.done"),
    item_id: z.string(),
    transcript: z.string(),
  }),
  z.object({ type: z.literal("output_audio_buffer.started") }),
  z.object({ type: z.literal("output_audio_buffer.stopped") }),
  z.object({ type: z.literal("output_audio_buffer.cleared") }),
  z.object({ type: z.literal("error") }),
]);

/** Protocol state, separate from microphone/WebRTC ownership. */
export class OpenAIConversationEvents {
  private closed = false;
  private activeResponse?: string;
  private awaitingResponse = false;
  private needsResponse = false;
  private speaking = false;
  private playing = false;
  private pendingTools = 0;
  private calls = new Set<string>();
  private contexts = new Map<string, string>();
  private transcript = { id: "", text: "" };

  constructor(
    private readonly send: (event: object) => void,
    private readonly callbacks: ConversationCallbacks,
  ) {}

  close() {
    this.closed = true;
  }

  private updateMode() {
    if (this.closed) return;
    this.callbacks.onModeChange({
      mode: this.playing
        ? "speaking"
        : this.activeResponse || this.awaitingResponse || this.pendingTools
          ? "working"
          : "listening",
    });
  }

  private respond() {
    if (
      this.closed ||
      !this.needsResponse ||
      this.speaking ||
      this.playing ||
      this.activeResponse ||
      this.awaitingResponse ||
      this.pendingTools
    )
      return;
    this.needsResponse = false;
    this.awaitingResponse = true;
    this.send({ type: "response.create" });
    this.updateMode();
  }

  contextualUpdate(text: string, contextId?: string) {
    if (this.closed) return;
    const id = `ctx_${crypto.randomUUID().replaceAll("-", "")}`;
    const previous = contextId ? this.contexts.get(contextId) : undefined;
    this.send({
      type: "conversation.item.create",
      item: {
        id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    if (previous)
      this.send({ type: "conversation.item.delete", item_id: previous });
    if (contextId) this.contexts.set(contextId, id);
  }

  userMessage(text: string) {
    this.contextualUpdate(text);
    this.needsResponse = true;
    this.respond();
  }

  private async execute(call: z.infer<typeof functionCall>) {
    let output: string;
    try {
      const tool = Object.hasOwn(this.callbacks.clientTools, call.name)
        ? this.callbacks.clientTools[call.name]
        : undefined;
      output = tool
        ? await tool(JSON.parse(call.arguments))
        : JSON.stringify({ status: "rejected", reason: "Unknown tool" });
    } catch {
      output = JSON.stringify({
        status: "rejected",
        reason: "The request could not be processed. Do not claim success.",
      });
    }
    if (this.closed) return;
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.call_id, output },
    });
    this.pendingTools--;
    this.needsResponse = true;
    this.respond();
    this.updateMode();
  }

  receive(raw: unknown) {
    if (this.closed) return;
    const parsed = serverEvent.safeParse(raw);
    if (!parsed.success) return;
    const event = parsed.data;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.speaking = true;
        this.callbacks.onUserSpeaking(true);
        this.callbacks.onVadScore({ vadScore: 1 });
        break;
      case "input_audio_buffer.speech_stopped":
        this.speaking = false;
        this.callbacks.onUserSpeaking(false);
        this.callbacks.onVadScore({ vadScore: 1 });
        break;
      case "input_audio_buffer.committed":
        // Transcription can arrive after tool calls. Register the utterance first.
        this.awaitingResponse = true;
        this.callbacks.onMessage({
          role: "user",
          message: "",
          event_id: event.item_id,
        });
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.callbacks.onMessage({
          role: "user",
          message: event.transcript,
          event_id: event.item_id,
        });
        break;
      case "response.created":
        this.activeResponse = event.response.id;
        this.awaitingResponse = false;
        this.needsResponse = false;
        break;
      case "response.done": {
        if (this.activeResponse === event.response.id)
          this.activeResponse = undefined;
        if (event.response.status === "failed") {
          this.callbacks.onError();
          return;
        }
        if (event.response.status === "completed") {
          for (const item of event.response.output) {
            const call = functionCall.safeParse(item);
            if (!call.success || this.calls.has(call.data.call_id)) continue;
            if (this.calls.size >= 512) {
              this.callbacks.onError();
              return;
            }
            this.calls.add(call.data.call_id);
            this.pendingTools++;
            void this.execute(call.data);
          }
        }
        this.respond();
        break;
      }
      case "response.output_audio_transcript.delta":
        if (this.transcript.id !== event.item_id)
          this.transcript = { id: event.item_id, text: "" };
        this.transcript.text = (this.transcript.text + event.delta).slice(
          0,
          12_000,
        );
        this.callbacks.onMessage({
          role: "agent",
          message: this.transcript.text,
        });
        break;
      case "response.output_audio_transcript.done":
        this.callbacks.onMessage({ role: "agent", message: event.transcript });
        break;
      case "output_audio_buffer.started":
        this.playing = true;
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.playing = false;
        this.respond();
        break;
      case "error":
        this.callbacks.onError();
        return;
    }
    this.updateMode();
  }
}
