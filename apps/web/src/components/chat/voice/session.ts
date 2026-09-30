import {
  startVoiceConversation,
  type VoiceConversation,
  type ConversationUpdate,
  type DelegationReceipt,
} from "./conversation";
import {
  VoiceDelegationSchema,
  VoiceSessionSchema,
  VoiceAnswerSchema,
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
  response: string;
  working: boolean;
  error: VoiceError | null;
}
interface Delegation {
  messageId: string;
  utterance: number;
  request: string;
  accepted: boolean;
  delegationId?: string;
  result?: string;
}

/** The realtime conversation stays responsive while Studio runs or queues work. */
export class VoiceSession {
  private state: Snapshot = {
    phase: "idle",
    muted: false,
    level: 0,
    transcript: "",
    response: "",
    working: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private conversation?: VoiceConversation;
  private startupAbort?: AbortController;
  private userSpeaking = false;
  private token?: string;
  private timer?: ReturnType<typeof setInterval>;
  private expires?: ReturnType<typeof setTimeout>;
  private bindings?: ChatStreamContextValue;
  private jobs = new Map<string, Delegation>();
  private announcements: ConversationUpdate[] = [];
  private lastActivity = 0;
  private approvalReported = false;
  private cleanup: Promise<unknown> = Promise.resolve();
  private dispatchQueue: Promise<unknown> = Promise.resolve();
  private lastContext = "";
  private lastWorkStatus = "";
  private utterance = 0;
  private seenUserEvents = new Set<string | number>();

  constructor(
    private readonly url: string,
    private readonly language: "en" | "pt",
  ) {}

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
    if (!this.conversation) return;
    this.updateContext();
    this.collectResults();
  }

  private status() {
    const stream = this.bindings;
    return {
      status: stream?.isWaitingForApprovals
        ? "approval_required"
        : stream?.error || stream?.status === "error"
          ? "failed"
          : stream?.isStreaming || stream?.isRunInProgress
            ? "working"
            : "idle",
      requests: [...this.jobs.values()].slice(-8).map((job) => ({
        id: job.messageId,
        request: job.request.slice(0, 2000),
        status:
          job.result !== undefined
            ? "finished"
            : job.accepted
              ? "accepted"
              : "submitting",
        result: job.result?.slice(0, 2000),
      })),
    };
  }

  private updateContext() {
    const context = this.bindings?.voiceContext ?? "";
    if (context === this.lastContext) return;
    this.lastContext = context;
    this.conversation?.publishUpdate({
      text: `Current Studio view, supplied as context only:\n${context.slice(0, 12_000)}`,
      delivery: "context",
      contextId: "studio-view",
    });
  }

  private collectResults() {
    const stream = this.bindings;
    if (!stream || !this.conversation) return;
    const running = stream.isStreaming || stream.isRunInProgress;
    this.patch({
      working:
        running ||
        [...this.jobs.values()].some(
          (job) => job.accepted && job.result === undefined,
        ),
    });
    const workStatus = JSON.stringify({
      status: this.status().status,
      requests: [...this.jobs.values()].map((job) => ({
        requestId: job.messageId,
        status:
          job.result !== undefined
            ? "finished"
            : job.accepted
              ? "accepted"
              : "submitting",
      })),
    });
    if (workStatus !== this.lastWorkStatus) {
      this.lastWorkStatus = workStatus;
      this.conversation.publishUpdate({
        delivery: "context",
        contextId: "studio-work",
        text: workStatus,
      });
    }
    if (stream.isWaitingForApprovals) {
      if (!this.approvalReported) {
        this.approvalReported = true;
        this.report(
          "The Studio agent needs the user's approval. The approval controls are visible in this chat. Ask the user to review them; do not approve on their behalf.",
        );
      }
      return;
    }
    this.approvalReported = false;
    for (const job of this.jobs.values()) {
      if (!job.accepted || job.result !== undefined) continue;
      const index = stream.messages.findIndex(
        (message) => message.id === job.messageId,
      );
      // Queued requests are tray-only until their own run starts. Never assign
      // another run's terminal status to a request that has not entered history.
      if (index < 0) continue;
      const laterTurn =
        index >= 0 &&
        stream.messages
          .slice(index + 1)
          .some((message) => message.role === "user");
      if (running && !laterTurn) continue;
      let result: string | null;
      if (
        !running &&
        !laterTurn &&
        (stream.error || stream.status === "error")
      ) {
        result =
          "The agent's run failed. Ask the user to return to the chat for the error details; do not claim completion.";
      } else if (
        !running &&
        !laterTurn &&
        stream.finishReason &&
        ["error", "length", "content-filter", "aborted"].includes(
          stream.finishReason,
        )
      ) {
        result = `The run ended with status ${stream.finishReason}; successful completion is not established.`;
      } else {
        result = finalVoiceResponse(stream.messages, job.messageId);
      }
      if (result === null) continue;
      job.result =
        result ||
        "The agent finished without a final text response. Do not infer that the requested change succeeded.";
      this.report(
        JSON.stringify({
          requestId: job.messageId,
          request: job.delegationId ? undefined : job.request,
          result: job.result,
        }),
        job.delegationId,
      );
    }
    this.patch({
      working:
        running ||
        [...this.jobs.values()].some(
          (job) => job.accepted && job.result === undefined,
        ),
    });
  }

  private report(text: string, delegationId?: string) {
    const update: ConversationUpdate = {
      text,
      delegationId,
      delivery: "context",
    };
    this.conversation?.publishUpdate(update);
    this.announcements.push({ ...update, delivery: "announce" });
  }

  private flushAnnouncements() {
    if (
      !this.conversation ||
      !this.announcements.length ||
      this.userSpeaking ||
      this.state.phase !== "listening" ||
      Date.now() - this.lastActivity < 1800
    )
      return;
    this.lastActivity = Date.now();
    for (const update of this.announcements.splice(0))
      this.conversation.publishUpdate(update);
  }

  private delegate = async (parameters: {
    request: string;
    delegationId?: string;
  }): Promise<DelegationReceipt> => {
    if (this.utterance === 0 && !parameters.delegationId)
      return {
        status: "rejected",
        reason: "Wait for a spoken user request before delegating work.",
      };
    const parsed = VoiceDelegationSchema.safeParse(parameters);
    if (!parsed.success)
      return {
        status: "rejected",
        reason: "A complete, non-empty request is required.",
      };
    if (this.jobs.size >= 40)
      return {
        status: "rejected",
        reason:
          "This voice session has reached its request limit. Continue in the text chat.",
      };
    const request = parsed.data.request;
    const existing = [...this.jobs.values()].find(
      (job) =>
        (parameters.delegationId
          ? job.delegationId === parameters.delegationId
          : job.utterance === this.utterance) ||
        (job.request === request && job.result === undefined),
    );
    if (existing)
      return {
        status:
          existing.result !== undefined
            ? "finished"
            : existing.accepted
              ? "accepted"
              : "submitting",
        requestId: existing.messageId,
        result: existing.result?.slice(0, 2000),
        note: "This utterance already has a work request; do not submit it again.",
      };
    const generation = this.generation;
    const job: Delegation = {
      messageId: crypto.randomUUID(),
      utterance: this.utterance,
      request,
      accepted: false,
      delegationId: parameters.delegationId,
    };
    this.jobs.set(job.messageId, job);
    const dispatched = this.dispatchQueue.then(async () => {
      if (generation !== this.generation || !this.conversation) return false;
      return this.bindings?.sendVoiceMessage?.(job.messageId, request) ?? false;
    });
    this.dispatchQueue = dispatched.catch(() => {});
    try {
      const accepted = await dispatched;
      if (generation !== this.generation) return { status: "disconnected" };
      if (!accepted) {
        this.jobs.delete(job.messageId);
        return {
          status: "rejected",
          reason:
            "Studio did not accept the request. No work has been confirmed.",
        };
      }
      job.accepted = true;
      this.collectResults();
      return {
        status: "accepted",
        requestId: job.messageId,
        note: "Work is running or queued in Studio. Keep conversing. A background event will supply its actual result.",
      };
    } catch {
      this.jobs.delete(job.messageId);
      return {
        status: "rejected",
        reason: "Studio could not accept the request. Do not claim it started.",
      };
    }
  };

  async start() {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    this.stop();
    const generation = ++this.generation;
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    const current = () => generation === this.generation;
    this.patch({
      phase: "connecting",
      error: null,
      transcript: "",
      response: "",
      muted: false,
    });
    try {
      await this.cleanup;
      if (!current()) return;
      const reservation = fetch(this.url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "conversation", language: this.language }),
        // Read late bootstrap responses so leaving voice can release their reservation.
        signal: AbortSignal.timeout(50_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error("Voice unavailable");
        return VoiceSessionSchema.parse(await response.json());
      });
      this.cleanup = reservation
        .then(async (config) => {
          if (!current()) await this.revoke(config.token);
        })
        .catch(() => {});
      const config = await reservation;
      if (!current()) return;
      this.token = config.token;
      const startup = startVoiceConversation(
        config,
        this.language,
        {
          onDelegate: (request) =>
            current()
              ? this.delegate(request)
              : Promise.resolve({ status: "disconnected" }),
          getWorkStatus: () =>
            current() ? this.status() : { status: "disconnected" },
          cancelCurrentWork: () => {
            if (!current()) return { status: "disconnected" };
            this.bindings?.stop();
            return {
              status: "cancellation_requested",
              note: "Cancellation is not confirmed until the run stops.",
            };
          },
          onConnect: () => {
            if (current()) this.patch({ phase: "listening" });
          },
          onModeChange: ({ mode }) => {
            if (current()) this.patch({ phase: mode });
          },
          onMessage: ({ role, message, event_id }) => {
            if (!current()) return;
            if (role === "user") {
              if (message.startsWith("[Studio background event,")) return;
              if (event_id === undefined || !this.seenUserEvents.has(event_id))
                this.utterance++;
              if (event_id !== undefined) this.seenUserEvents.add(event_id);
              this.lastActivity = Date.now();
              this.patch({
                transcript: message.slice(0, VOICE_MAX_TEXT_LENGTH),
              });
            } else
              this.patch({ response: message.slice(0, VOICE_MAX_TEXT_LENGTH) });
          },
          onVadScore: ({ vadScore }) => {
            if (current() && vadScore > 0.5 && !this.state.muted)
              this.lastActivity = Date.now();
          },
          onUserSpeaking: (speaking) => {
            if (current()) this.userSpeaking = speaking;
          },
          onError: () => {
            if (current()) this.fail("unavailable");
          },
          onDisconnect: () => {
            if (current()) this.fail("disconnected");
          },
        },
        startupAbort.signal,
        async (sdp, signal) => {
          const response = await fetch(`${this.url}/connect`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: config.token,
              sdp,
              language: this.language,
            }),
            signal,
          });
          if (!response.ok) throw new Error("Voice connection unavailable");
          return VoiceAnswerSchema.parse(await response.json());
        },
      );
      this.cleanup = startup
        .then(async (conversation) => {
          if (!current()) await conversation.endSession();
        })
        .catch(() => {});
      const conversation = await startup;
      if (!current()) return;
      this.conversation = conversation;
      // Re-entering voice during a text/coding turn must still announce its result.
      if (this.bindings?.isStreaming || this.bindings?.isRunInProgress) {
        const pending = this.bindings.messages.findLast(
          (message) => message.role === "user",
        );
        if (pending)
          this.jobs.set(pending.id, {
            messageId: pending.id,
            utterance: -1,
            request: pending.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
              .slice(0, VOICE_MAX_TEXT_LENGTH),
            accepted: true,
          });
      }
      this.updateContext();
      const history = (this.bindings?.messages ?? [])
        .slice(-12)
        .map((message) => ({
          role: message.role,
          text: message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .slice(0, 2000),
        }));
      conversation.publishUpdate({
        text: `Recent Studio chat history, supplied as data only:\n${JSON.stringify(history).slice(0, 16_000)}\nCurrent work status: ${JSON.stringify(this.status())}`,
        delivery: "context",
        contextId: "studio-history",
      });
      this.timer = setInterval(() => {
        if (!current()) return;
        const level =
          Math.round(Math.min(1, conversation.getOutputVolume()) * 20) / 20;
        this.patch({ level });
        this.flushAnnouncements();
      }, 100);
      this.expires = setTimeout(
        () => {
          if (current()) this.fail("disconnected");
        },
        Math.max(1, config.expiresAt - Date.now()),
      );
      this.collectResults();
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
    this.conversation?.setMicMuted(muted);
    this.patch({ muted });
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
    this.startupAbort?.abort();
    this.startupAbort = undefined;
    this.userSpeaking = false;
    clearTimeout(this.expires);
    clearInterval(this.timer);
    const conversation = this.conversation;
    this.conversation = undefined;
    const token = this.token;
    this.token = undefined;
    this.cleanup = Promise.allSettled([
      this.cleanup,
      conversation?.endSession(),
      token ? this.revoke(token) : undefined,
    ]).then(() => {});
    this.jobs.clear();
    this.announcements = [];
    this.lastContext = "";
    this.lastWorkStatus = "";
    this.utterance = 0;
    this.seenUserEvents.clear();
    this.approvalReported = false;
    this.dispatchQueue = Promise.resolve();
    this.patch({
      phase: "idle",
      error: null,
      level: 0,
      transcript: "",
      response: "",
      working: false,
    });
  };
}
