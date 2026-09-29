import type { RealtimeConnection } from "@elevenlabs/client";
import {
  VoiceSessionSchema,
  VOICE_MAX_TEXT_LENGTH,
} from "@decocms/shared/voice";
import type { ChatStreamContextValue } from "../chat-context";
import { finalVoiceResponse } from "./final-response";

type Phase =
  | "idle"
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "error";
type VoiceError = "permission" | "unavailable" | "disconnected" | "sendFailed";
interface Snapshot {
  phase: Phase;
  muted: boolean;
  level: number;
  transcript: string;
  error: VoiceError | null;
}

/** Owns microphone/playback lifetime independently from the Studio run. */
export class VoiceSession {
  private state: Snapshot = {
    phase: "idle",
    muted: false,
    level: 0,
    transcript: "",
    error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private transcription?: RealtimeConnection;
  private audio?: AudioContext;
  private playback?: AudioBufferSourceNode;
  private analyser?: AnalyserNode;
  private speechAbort?: AbortController;
  private abort?: AbortController;
  private token?: string;
  private timer?: ReturnType<typeof setInterval>;
  private expires?: ReturnType<typeof setTimeout>;
  private bindings?: ChatStreamContextValue;
  private pending?: { messageId: string; accepted: boolean };
  private receivingSpeech = false;
  private sendQueue: Promise<void> = Promise.resolve();
  private cleanup: Promise<unknown> = Promise.resolve();

  constructor(private readonly url: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;

  private patch(next: Partial<Snapshot>) {
    if (
      Object.entries(next).every(
        ([key, value]) => this.state[key as keyof Snapshot] === value,
      )
    )
      return;
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  updateBindings(bindings: ChatStreamContextValue, enabled: boolean) {
    this.bindings = bindings;
    if (!enabled && this.state.phase !== "idle") {
      this.stop();
      return;
    }
    this.flushResponse();
  }

  private flushResponse() {
    const current = this.pending;
    const stream = this.bindings;
    if (
      !current?.accepted ||
      this.receivingSpeech ||
      !stream ||
      stream.isStreaming ||
      stream.isRunInProgress ||
      stream.isWaitingForApprovals
    )
      return;
    if (stream.error || stream.status === "error") {
      this.fail("sendFailed");
      return;
    }
    if (
      stream.finishReason &&
      ["error", "length", "content-filter", "aborted"].includes(
        stream.finishReason,
      )
    ) {
      this.pending = undefined;
      this.patch({ phase: "listening" });
      return;
    }
    const text = finalVoiceResponse(stream.messages, current.messageId);
    if (text === null) return;
    this.pending = undefined;
    if (text) void this.speak(text);
    else this.patch({ phase: "listening" });
  }

  private interruptPlayback() {
    this.speechAbort?.abort();
    this.speechAbort = undefined;
    if (this.playback) {
      this.playback.onended = null;
      this.playback.stop();
      this.playback.disconnect();
      this.playback = undefined;
    }
    this.analyser?.disconnect();
    this.analyser = undefined;
    clearInterval(this.timer);
    this.patch({ level: 0 });
  }

  private async speak(text: string) {
    this.interruptPlayback();
    const audio = this.audio;
    if (!audio || !this.token) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.speechAbort = abort;
    const current = () =>
      generation === this.generation && !abort.signal.aborted;
    try {
      const response = await fetch(`${this.url}/speech`, {
        method: "POST",
        credentials: "include",
        signal: abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.token, text }),
      });
      if (!response.ok) throw new Error("Speech unavailable");
      const buffer = await audio.decodeAudioData(await response.arrayBuffer());
      if (!current()) return;
      await audio.resume();
      if (!current()) return;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      const analyser = audio.createAnalyser();
      this.analyser = analyser;
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(audio.destination);
      this.playback = source;
      const samples = new Uint8Array(analyser.frequencyBinCount);
      this.timer = setInterval(() => {
        analyser.getByteFrequencyData(samples);
        const level =
          samples.reduce((sum, value) => sum + value, 0) / samples.length / 128;
        this.patch({ level: Math.round(Math.min(1, level) * 20) / 20 });
      }, 100);
      source.onended = () => {
        if (!current()) return;
        this.interruptPlayback();
        analyser.disconnect();
        this.patch({ phase: this.pending ? "working" : "listening" });
      };
      source.start();
      this.patch({ phase: "speaking" });
    } catch {
      if (current()) this.fail("unavailable");
    }
  }

  private submit(text: string) {
    text = text.trim();
    if (!text || this.state.muted) return;
    if (text.length > VOICE_MAX_TEXT_LENGTH) {
      this.fail("sendFailed");
      return;
    }
    this.receivingSpeech = false;
    this.interruptPlayback();
    const generation = this.generation;
    const current = () => generation === this.generation;
    const messageId = crypto.randomUUID();
    this.pending = { messageId, accepted: false };
    this.patch({ phase: "working", transcript: text });
    this.sendQueue = this.sendQueue
      .then(async () => {
        if (!current()) return;
        const accepted = await this.bindings?.sendVoiceMessage?.(
          messageId,
          text,
        );
        if (!current()) return;
        if (!accepted) {
          this.fail("sendFailed");
          return;
        }
        if (this.pending?.messageId === messageId) this.pending.accepted = true;
        this.flushResponse();
      })
      .catch(() => {
        if (current()) this.fail("sendFailed");
      });
  }

  async start() {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    this.stop();
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.patch({
      phase: "connecting",
      error: null,
      transcript: "",
      muted: false,
    });
    try {
      // Unlock playback during the user's gesture, before network or microphone waits.
      this.audio = new AudioContext();
      await this.audio.resume();
      await this.cleanup;
      if (!current()) return;
      const reservation = fetch(this.url, {
        method: "POST",
        credentials: "include",
        signal: AbortSignal.timeout(20_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error("Voice unavailable");
        return VoiceSessionSchema.parse(await response.json());
      });
      // Finish releasing a cancelled startup before allowing another session.
      this.cleanup = reservation
        .then(async (config) => {
          if (!current()) await this.revoke(config.token);
        })
        .catch(() => {});
      const config = await reservation;
      if (!current()) return;
      this.token = config.token;
      const { Scribe, RealtimeEvents, CommitStrategy } = await import(
        "@elevenlabs/client"
      );
      if (!current()) return;
      const connection = Scribe.connect({
        token: config.transcriptionToken,
        modelId: "scribe_v2_realtime",
        commitStrategy: CommitStrategy.VAD,
        vadSilenceThresholdSecs: 1.5,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.transcription = connection;
      const timeout = setTimeout(() => {
        if (current()) this.fail("unavailable");
      }, 15_000);
      abort.signal.addEventListener("abort", () => clearTimeout(timeout), {
        once: true,
      });
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        clearTimeout(timeout);
        if (current()) this.patch({ phase: "listening" });
      });
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
        if (!current() || this.state.muted || !text.trim()) return;
        this.receivingSpeech = true;
        this.interruptPlayback();
        this.patch({
          phase: "listening",
          transcript: text.slice(0, VOICE_MAX_TEXT_LENGTH),
        });
      });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
        if (current()) this.submit(text);
      });
      connection.on(RealtimeEvents.ERROR, () => {
        if (current()) this.fail("unavailable");
      });
      connection.on(RealtimeEvents.CLOSE, () => {
        if (current()) this.fail("disconnected");
      });
      this.expires = setTimeout(
        () => {
          if (current()) this.fail("disconnected");
        },
        Math.max(1, config.expiresAt - Date.now()),
      );
    } catch (error) {
      if (current())
        this.fail(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "permission"
            : "unavailable",
        );
    }
  }

  toggleMute = () => {
    const muted = !this.state.muted;
    try {
      if (muted) this.transcription?.mute();
      else this.transcription?.unmute();
      this.patch({ muted });
      if (muted) {
        this.receivingSpeech = false;
        this.flushResponse();
      }
    } catch {
      // Microphone acquisition may still be pending immediately after connection.
    }
  };

  private fail(error: VoiceError) {
    this.stop();
    this.patch({ phase: "error", error });
  }

  private async revoke(token: string) {
    await fetch(this.url, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      keepalive: true,
    }).catch(() => {});
  }

  stop = () => {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    clearTimeout(this.expires);
    this.transcription?.close();
    this.transcription = undefined;
    this.interruptPlayback();
    const closed = this.audio?.close().catch(() => {});
    this.audio = undefined;
    const token = this.token;
    this.token = undefined;
    this.cleanup = Promise.allSettled([
      this.cleanup,
      closed,
      token ? this.revoke(token) : undefined,
    ]).then(() => {});
    this.pending = undefined;
    this.receivingSpeech = false;
    this.sendQueue = Promise.resolve();
    this.patch({ phase: "idle", error: null, level: 0, transcript: "" });
  };
}
