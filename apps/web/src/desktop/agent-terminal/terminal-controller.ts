import { exponentialBackoffWithJitter } from "@decocms/shared/std";
import { Store } from "@/components/chat/store/store-primitive";
import { translate } from "@/i18n/use-t";
import {
  appendTerminalReplay,
  chunkTerminalInput,
  normalizeTerminalDimensions,
  parseTerminalServerFrame,
  shouldResetTerminalReplay,
  terminalLifecycleAfterExit,
  terminalWebSocketUrl,
  threadStatusFromTerminalLifecycle,
  type TerminalClientFrame,
  type TerminalDimensions,
  type TerminalHarnessId,
  type TerminalLogicalState,
  type TerminalPhysicalState,
  type TerminalReplayFrame,
  type TerminalServerFrame,
} from "./protocol";
import { createTerminalCapabilityQueryBoundaryScanner } from "./terminal-capability-replies";

export type TerminalConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface TerminalControllerSnapshot {
  connection: TerminalConnectionState;
  hasSession: boolean;
  sessionId: string | null;
  generation: string | null;
  harnessId: TerminalHarnessId | null;
  physicalState: TerminalPhysicalState | "failed" | null;
  logicalState: TerminalLogicalState | null;
  threadStatus:
    | "in_progress"
    | "requires_action"
    | "failed"
    | "completed"
    | null;
  pendingPromptCount: number;
  error: Error | null;
  retryable: boolean;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingPrompt extends Deferred {
  frame: Extract<TerminalClientFrame, { type: "submit_prompt" }>;
  sentAsInitial: boolean;
  sentSocket: WebSocket | null;
}

type ConnectionIntent =
  | { kind: "attach" }
  | {
      kind: "start";
      frame: Extract<TerminalClientFrame, { type: "start" }>;
    };

export interface TerminalControllerOutputFrame extends TerminalReplayFrame {
  restorePendingCapabilityReplies: boolean;
}

type TerminalOutputListener = (
  frame: TerminalControllerOutputFrame,
  acknowledgeCapabilityReplies: () => void,
) => void;

interface StoredTerminalReplayFrame extends TerminalReplayFrame {
  capabilityReplyAuthorityId: number | null;
  pendingCapabilityReplyAuthorityId: number | null;
  pendingCapabilityReplyAuthorityIdsToClear: number[];
}

const DEFAULT_DIMENSIONS: TerminalDimensions = { rows: 30, cols: 100 };
// Matches terminal-session's bounded replay capacity. Keeping the full reset
// avoids requesting the same multi-megabyte snapshot on every panel remount.
const REPLAY_BYTE_LIMIT = 4 * 1024 * 1024;
const BASE_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

export function terminalReplayRequiresAuthorityPrune(
  frameKind: TerminalReplayFrame["kind"],
  previousFirst: object | undefined,
  nextFirst: object | undefined,
): boolean {
  return (
    frameKind === "reset" ||
    (previousFirst !== undefined && nextFirst !== previousFirst)
  );
}

/**
 * The server may have written this prompt to the PTY before the socket closed.
 * Retrying it automatically would be a duplicate side effect, so callers must
 * treat this separately from a definitive server rejection.
 */
export class TerminalPromptDeliveryUnknownError extends Error {
  override readonly name = "TerminalPromptDeliveryUnknownError";

  constructor() {
    super(translate("chat.nativeTerminal.promptDeliveryUnknown"));
  }
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function initialSnapshot(): TerminalControllerSnapshot {
  return {
    connection: "disconnected",
    hasSession: false,
    sessionId: null,
    generation: null,
    harnessId: null,
    physicalState: null,
    logicalState: null,
    threadStatus: null,
    pendingPromptCount: 0,
    error: null,
    retryable: false,
  };
}

export class TerminalController {
  readonly snapshot = new Store<TerminalControllerSnapshot>(initialSnapshot());

  private socket: WebSocket | null = null;
  private intent: ConnectionIntent | null = null;
  private dimensions = DEFAULT_DIMENSIONS;
  private replay: StoredTerminalReplayFrame[] = [];
  private replayComplete = true;
  private lastOutputSequence = 0;
  private outputListeners = new Set<TerminalOutputListener>();
  // null = available; a listener value = leased until its xterm write acks.
  private capabilityReplyAuthorities = new Map<
    number,
    TerminalOutputListener | null
  >();
  private nextCapabilityReplyAuthorityId = 1;
  private readonly capabilityQueryBoundaryScanner =
    createTerminalCapabilityQueryBoundaryScanner();
  private pendingCapabilityReplyAuthority: {
    generation: number;
    id: number;
  } | null = null;
  private startupReplySocket: WebSocket | null = null;
  private pendingPrompts = new Map<string, PendingPrompt>();
  private startDeferred: Deferred | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private retainCount = 0;
  private disposed = false;

  constructor(
    readonly orgSlug: string,
    readonly threadId: string,
    private readonly onUnused?: (controller: TerminalController) => void,
  ) {}

  retain(): void {
    if (this.disposed) return;
    this.retainCount++;
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  release(): void {
    this.retainCount = Math.max(0, this.retainCount - 1);
    if (this.retainCount > 0 || this.releaseTimer !== null) return;
    // A zero-delay grace period keeps React Strict Mode's mount/unmount probe
    // from tearing down a socket that the immediate remount will reuse.
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.retainCount === 0) {
        this.disconnectView();
        this.onUnused?.(this);
      }
    }, 0);
  }

  ensureAttached(harnessId?: TerminalHarnessId | null): void {
    if (harnessId && this.snapshot.get().harnessId === null) {
      this.patch({ harnessId });
    }
    if (this.intent?.kind !== "start") this.intent = { kind: "attach" };
    this.connect();
  }

  start(
    harnessId: TerminalHarnessId,
    options: { initialPrompt?: string; requestId?: string } = {},
  ): Promise<void> {
    if (this.intent?.kind === "start" && this.startDeferred) {
      if (options.initialPrompt && options.requestId) {
        return (
          this.pendingPrompts.get(options.requestId)?.promise ??
          this.startDeferred.promise
        );
      }
      return this.startDeferred.promise;
    }

    this.startupReplySocket = null;
    this.resetRendererReplay();

    const dimensions = normalizeTerminalDimensions(this.dimensions);
    const requestId = options.requestId ?? crypto.randomUUID();
    const frame: Extract<TerminalClientFrame, { type: "start" }> = {
      type: "start",
      harnessId,
      ...dimensions,
      ...(options.initialPrompt
        ? { initialPrompt: options.initialPrompt }
        : {}),
      requestId,
    };

    if (options.initialPrompt) {
      this.trackPrompt(
        {
          type: "submit_prompt",
          text: options.initialPrompt,
          requestId,
        },
        true,
      );
    }

    if (!this.startDeferred) {
      this.startDeferred = deferred();
      // Initial-prompt starts resolve through the prompt acknowledgement; keep
      // the separate ready latch handled even when no caller awaits it.
      void this.startDeferred.promise.catch(() => {});
    }
    this.intent = { kind: "start", frame };
    this.patch({
      connection:
        this.socket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
      hasSession: false,
      harnessId,
      physicalState: "starting",
      error: null,
      retryable: false,
    });
    this.connect();
    this.sendIntent();

    if (options.initialPrompt) {
      return this.pendingPrompts.get(requestId)?.promise ?? Promise.resolve();
    }
    return this.startDeferred.promise;
  }

  submitPrompt(
    text: string,
    requestId: string = crypto.randomUUID(),
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve();
    const existing = this.pendingPrompts.get(requestId);
    if (existing) return existing.promise;

    const pending = this.trackPrompt(
      {
        type: "submit_prompt",
        text: trimmed,
        requestId,
      },
      false,
    );
    this.patch({ error: null, retryable: false });
    if (!this.intent) this.intent = { kind: "attach" };
    this.connect();
    this.flushPrompts();
    return pending.promise;
  }

  input(data: string): void {
    const snapshot = this.snapshot.get();
    if (
      !data ||
      !snapshot.hasSession ||
      snapshot.connection !== "connected" ||
      snapshot.physicalState !== "running"
    ) {
      return;
    }
    for (const chunk of chunkTerminalInput(data)) {
      this.send({ type: "input", data: chunk });
    }
  }

  resize(dimensions: TerminalDimensions): void {
    const next = normalizeTerminalDimensions(dimensions);
    if (
      next.rows === this.dimensions.rows &&
      next.cols === this.dimensions.cols
    ) {
      return;
    }
    this.dimensions = next;
    if (this.snapshot.get().hasSession) {
      this.send({ type: "resize", ...next });
    }
  }

  interrupt(): void {
    if (this.snapshot.get().hasSession) this.send({ type: "interrupt" });
  }

  terminate(): void {
    if (this.snapshot.get().hasSession) this.send({ type: "terminate" });
  }

  retry(): void {
    this.patch({ error: null, retryable: false });
    if (!this.intent && this.snapshot.get().harnessId) {
      this.intent = { kind: "attach" };
    }
    this.connect(true);
  }

  clearError(): void {
    this.patch({ error: null, retryable: false });
  }

  reportError(error: Error, retryable = false): void {
    this.patch({ error, retryable });
  }

  subscribeOutput(listener: TerminalOutputListener): () => void {
    this.outputListeners.add(listener);
    if (!this.replayComplete) {
      this.replay = [];
      this.capabilityReplyAuthorities.clear();
      this.capabilityQueryBoundaryScanner.reset();
      this.pendingCapabilityReplyAuthority = null;
      this.replayComplete = true;
      this.lastOutputSequence = 0;
    }
    for (const frame of this.replay) this.deliverOutput(listener, frame);
    this.connect();
    return () => {
      this.outputListeners.delete(listener);
      this.releaseCapabilityReplyLeases(listener);
      if (this.outputListeners.size === 0 && this.pendingPrompts.size === 0) {
        this.disconnectView();
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.releaseTimer = null;
    this.reconnectTimer = null;
    this.socket?.close(1000, "controller disposed");
    this.socket = null;
    this.startupReplySocket = null;
    this.capabilityReplyAuthorities.clear();
    const error = new Error(
      translate("chat.nativeTerminal.chatClosedBeforePrompt"),
    );
    this.startDeferred?.reject(error);
    this.startDeferred = null;
    this.rejectPendingPrompts(error, true);
  }

  private connect(force = false): void {
    if (this.disposed || !this.intent) return;
    if (
      !force &&
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      if (this.startupReplySocket === this.socket) {
        this.startupReplySocket = null;
      }
      this.rejectPromptsSentOn(this.socket);
      this.socket.close(1000, "reconnecting");
    }

    const hadConnection = this.snapshot.get().connection !== "disconnected";
    this.patch({
      connection: hadConnection ? "reconnecting" : "connecting",
      ...(this.hasUnknownDeliveryError() ? {} : { error: null }),
    });

    const socket = new WebSocket(
      terminalWebSocketUrl(window.location, this.orgSlug, this.threadId),
    );
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.disposed) return;
      this.reconnectAttempt = 0;
      this.patch({
        connection: "connected",
        ...(this.hasUnknownDeliveryError()
          ? {}
          : { error: null, retryable: false }),
      });
      this.sendIntent();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      const frame = parseTerminalServerFrame(event.data);
      if (frame) this.handleFrame(frame, socket);
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.patch({
        error: new Error(translate("chat.nativeTerminal.connectionFailed")),
        retryable: true,
      });
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.startupReplySocket === socket) {
        this.startupReplySocket = null;
      }
      this.rejectPromptsSentOn(socket);
      if (
        this.disposed ||
        this.retainCount === 0 ||
        (this.outputListeners.size === 0 && this.pendingPrompts.size === 0)
      ) {
        this.patch({ connection: "disconnected" });
        return;
      }
      const state = this.snapshot.get();
      if (
        state.physicalState === "exited" ||
        state.physicalState === "failed" ||
        ((state.logicalState === "failed" ||
          state.logicalState === "interrupted") &&
          !state.retryable)
      ) {
        this.patch({ connection: "disconnected" });
        return;
      }
      this.patch({ connection: "reconnecting" });
      this.scheduleReconnect();
    };
  }

  private disconnectView(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (this.startupReplySocket === socket) {
      this.startupReplySocket = null;
    }
    socket?.close(1000, "view detached");
    this.patch({ connection: "disconnected" });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.disposed || !this.intent) return;
    const delay = exponentialBackoffWithJitter(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS,
      this.reconnectAttempt,
      2,
      0.5,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendIntent(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.intent) return;
    if (this.intent.kind === "start") {
      const requestId = this.intent.frame.requestId;
      const initial =
        this.intent.frame.initialPrompt && requestId
          ? this.pendingPrompts.get(requestId)
          : undefined;
      if (initial?.sentSocket) {
        this.intent = { kind: "attach" };
        this.sendIntent();
        return;
      }
      const socket = this.send(this.intent.frame);
      if (socket) {
        this.startupReplySocket = socket;
        if (initial) initial.sentSocket = socket;
      }
      return;
    }
    this.send({
      type: "attach",
      ...(this.lastOutputSequence > 0
        ? { afterSeq: this.lastOutputSequence }
        : {}),
      ...this.dimensions,
    });
  }

  private send(frame: TerminalClientFrame): WebSocket | null {
    if (this.socket?.readyState !== WebSocket.OPEN) return null;
    this.socket.send(JSON.stringify(frame));
    return this.socket;
  }

  private trackPrompt(
    frame: Extract<TerminalClientFrame, { type: "submit_prompt" }>,
    sentAsInitial: boolean,
  ): PendingPrompt {
    const existing = this.pendingPrompts.get(frame.requestId);
    if (existing) return existing;
    const pending = {
      ...deferred(),
      frame,
      sentAsInitial,
      sentSocket: null,
    };
    this.pendingPrompts.set(frame.requestId, pending);
    this.patch({ pendingPromptCount: this.pendingPrompts.size });
    return pending;
  }

  private flushPrompts(skipInitial = false): void {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.snapshot.get().hasSession
    ) {
      return;
    }
    for (const pending of this.pendingPrompts.values()) {
      if (skipInitial && pending.sentAsInitial) continue;
      if (pending.sentSocket) continue;
      pending.sentAsInitial = false;
      pending.sentSocket = this.send(pending.frame);
    }
  }

  private handleFrame(frame: TerminalServerFrame, socket: WebSocket): void {
    switch (frame.type) {
      case "ready": {
        const wasStarting = this.intent?.kind === "start";
        const previous = this.snapshot.get();
        if (
          !wasStarting &&
          shouldResetTerminalReplay(
            previous.sessionId,
            this.lastOutputSequence,
            frame,
          )
        ) {
          this.resetRendererReplay();
          this.patch({ hasSession: false });
          this.intent = { kind: "attach" };
          this.connect(true);
          return;
        }
        this.intent = { kind: "attach" };
        this.patch({
          hasSession: true,
          sessionId: frame.sessionId ?? null,
          generation: frame.generation,
          harnessId: frame.harnessId ?? this.snapshot.get().harnessId,
          physicalState: frame.physicalState,
          logicalState: frame.logicalState,
          threadStatus: threadStatusFromTerminalLifecycle(
            frame.physicalState,
            frame.logicalState,
          ),
          ...(this.hasUnknownDeliveryError()
            ? {}
            : { error: null, retryable: false }),
        });
        this.startDeferred?.resolve();
        this.startDeferred = null;
        this.send({ type: "resize", ...this.dimensions });
        this.flushPrompts(wasStarting);
        this.detachIfUnused();
        return;
      }
      case "output": {
        // Every connection receives a server-marked retained tail. Only the
        // socket that issued `start` owns replies for that initial tail;
        // ordinary attach/reconnect history must remain inert.
        const startupReplay =
          frame.replay && this.startupReplySocket === socket;
        if (!frame.replay && this.startupReplySocket === socket) {
          this.startupReplySocket = null;
        }
        this.acceptOutput({
          kind: "output",
          seq: frame.seq,
          data: frame.data,
          allowCapabilityReplies: !frame.replay || startupReplay,
        });
        return;
      }
      case "reset":
        this.acceptOutput({
          kind: "reset",
          seq: frame.seq,
          data: frame.data,
          allowCapabilityReplies: false,
        });
        return;
      case "state":
        this.patch({
          hasSession: true,
          harnessId: frame.harnessId ?? this.snapshot.get().harnessId,
          physicalState: frame.physicalState,
          logicalState: frame.logicalState,
          threadStatus:
            frame.threadStatus && frame.threadStatus !== "expired"
              ? frame.threadStatus
              : threadStatusFromTerminalLifecycle(
                  frame.physicalState,
                  frame.logicalState,
                ),
          ...(this.hasUnknownDeliveryError()
            ? {}
            : { error: null, retryable: false }),
        });
        return;
      case "prompt_accepted": {
        const pending = this.pendingPrompts.get(frame.requestId);
        if (!pending) return;
        this.pendingPrompts.delete(frame.requestId);
        this.patch({
          pendingPromptCount: this.pendingPrompts.size,
          error: null,
          retryable: false,
        });
        pending.resolve();
        this.detachIfUnused();
        return;
      }
      case "exit": {
        const lifecycle = terminalLifecycleAfterExit(
          frame,
          this.snapshot.get().logicalState,
        );
        const error =
          !frame.expected && lifecycle.logicalState === "failed"
            ? new Error(translate("chat.nativeTerminal.unexpectedExit"))
            : null;
        const pendingExitError =
          error ??
          new Error(translate("chat.nativeTerminal.exitedBeforeReady"));
        this.patch({
          physicalState: "exited",
          logicalState: lifecycle.logicalState,
          threadStatus: lifecycle.threadStatus,
          error,
          retryable: error !== null,
        });
        if (this.startDeferred) {
          this.startDeferred.reject(pendingExitError);
          this.startDeferred = null;
        }
        if (this.pendingPrompts.size > 0) {
          this.rejectPendingPrompts(pendingExitError, true);
        }
        this.disconnectView();
        return;
      }
      case "error": {
        const error = new Error(frame.message);
        if (
          frame.code === "prompt_rejected" ||
          frame.code === "agent_busy" ||
          frame.code === "stale_attachment"
        ) {
          const pendingEntry = frame.requestId
            ? ([
                frame.requestId,
                this.pendingPrompts.get(frame.requestId),
              ] as const)
            : (this.pendingPrompts.entries().next().value as
                | [string, PendingPrompt]
                | undefined);
          if (pendingEntry?.[1]) {
            this.pendingPrompts.delete(pendingEntry[0]);
            this.patch({ pendingPromptCount: this.pendingPrompts.size });
            pendingEntry[1].reject(error);
          }
          this.patch({ error, retryable: frame.retryable });
          if (frame.code === "stale_attachment") {
            // A newer window owns the writer lease. This renderer stays
            // disconnected until the user explicitly retries, rather than
            // fighting the newer window for ownership in a reconnect loop.
            this.intent = null;
            this.disconnectView();
          }
          this.detachIfUnused();
          return;
        }
        this.patch({
          physicalState: this.snapshot.get().hasSession
            ? this.snapshot.get().physicalState
            : "failed",
          logicalState: this.snapshot.get().hasSession
            ? this.snapshot.get().logicalState
            : "failed",
          error,
          retryable: frame.retryable,
        });
        this.startDeferred?.reject(error);
        this.startDeferred = null;
        this.rejectPendingPrompts(error, true);
        return;
      }
    }
  }

  private acceptOutput(frame: TerminalReplayFrame): void {
    const currentSequence = this.lastOutputSequence;
    if (frame.seq <= currentSequence && frame.kind !== "reset") return;
    if (frame.kind === "reset" && frame.seq < currentSequence) return;

    const previousFirst = this.replay[0];
    const pendingCapabilityReplyAuthorityIdsToClear: number[] = [];
    if (frame.kind === "reset") {
      this.capabilityQueryBoundaryScanner.reset();
      if (this.pendingCapabilityReplyAuthority) {
        pendingCapabilityReplyAuthorityIdsToClear.push(
          this.pendingCapabilityReplyAuthority.id,
        );
        this.pendingCapabilityReplyAuthority = null;
      }
    }
    this.capabilityQueryBoundaryScanner.observe(
      frame.data,
      frame.allowCapabilityReplies,
    );
    const pendingQuery =
      this.capabilityQueryBoundaryScanner.pendingReplyAuthority();
    if (
      this.pendingCapabilityReplyAuthority &&
      (pendingQuery?.generation !==
        this.pendingCapabilityReplyAuthority.generation ||
        !pendingQuery.repliesAllowed)
    ) {
      pendingCapabilityReplyAuthorityIdsToClear.push(
        this.pendingCapabilityReplyAuthority.id,
      );
      this.pendingCapabilityReplyAuthority = null;
    }
    if (pendingQuery?.repliesAllowed && !this.pendingCapabilityReplyAuthority) {
      const pendingCapabilityReplyAuthorityId = this
        .nextCapabilityReplyAuthorityId++;
      this.capabilityReplyAuthorities.set(
        pendingCapabilityReplyAuthorityId,
        null,
      );
      this.pendingCapabilityReplyAuthority = {
        generation: pendingQuery.generation,
        id: pendingCapabilityReplyAuthorityId,
      };
    }
    // Every retained chunk that belongs to the same incomplete query carries
    // its authority id. During remount replay each chunk is observed with
    // `allowCapabilityReplies: false`, so the renderer must restore the
    // pending authority after every observation until the query completes.
    const pendingCapabilityReplyAuthorityId =
      this.pendingCapabilityReplyAuthority?.id ?? null;
    const capabilityReplyAuthorityId = frame.allowCapabilityReplies
      ? this.nextCapabilityReplyAuthorityId++
      : null;
    if (capabilityReplyAuthorityId !== null) {
      this.capabilityReplyAuthorities.set(capabilityReplyAuthorityId, null);
    }
    const retainedFrame: StoredTerminalReplayFrame = {
      ...frame,
      allowCapabilityReplies: false,
      capabilityReplyAuthorityId,
      pendingCapabilityReplyAuthorityId,
      pendingCapabilityReplyAuthorityIdsToClear,
    };
    const nextReplay = appendTerminalReplay(
      this.replay,
      retainedFrame,
      REPLAY_BYTE_LIMIT,
    );
    if (frame.kind === "reset") {
      this.replayComplete = frame.data.byteLength <= REPLAY_BYTE_LIMIT;
    } else if (
      frame.data.byteLength > REPLAY_BYTE_LIMIT ||
      (previousFirst !== undefined && nextReplay[0] !== previousFirst)
    ) {
      this.replayComplete = false;
    }
    this.replay = nextReplay;
    if (
      terminalReplayRequiresAuthorityPrune(
        frame.kind,
        previousFirst,
        nextReplay[0],
      )
    ) {
      this.pruneCapabilityReplyAuthorities();
    }
    this.lastOutputSequence = frame.seq;
    if (this.snapshot.get().error) {
      this.patch({ error: null, retryable: false });
    }
    for (const listener of this.outputListeners) {
      this.deliverOutput(listener, retainedFrame);
    }
  }

  private deliverOutput(
    listener: TerminalOutputListener,
    frame: StoredTerminalReplayFrame,
  ): void {
    const authorityId = frame.capabilityReplyAuthorityId;
    const allowCapabilityReplies =
      authorityId !== null &&
      this.capabilityReplyAuthorities.has(authorityId) &&
      this.capabilityReplyAuthorities.get(authorityId) === null;
    if (allowCapabilityReplies) {
      this.capabilityReplyAuthorities.set(authorityId, listener);
    }
    const pendingAuthorityId = frame.pendingCapabilityReplyAuthorityId;
    const restorePendingCapabilityReplies =
      pendingAuthorityId !== null &&
      this.capabilityReplyAuthorities.has(pendingAuthorityId) &&
      (this.capabilityReplyAuthorities.get(pendingAuthorityId) === null ||
        this.capabilityReplyAuthorities.get(pendingAuthorityId) === listener);
    if (
      restorePendingCapabilityReplies &&
      this.capabilityReplyAuthorities.get(pendingAuthorityId) === null
    ) {
      this.capabilityReplyAuthorities.set(pendingAuthorityId, listener);
    }
    listener(
      {
        kind: frame.kind,
        seq: frame.seq,
        data: frame.data,
        allowCapabilityReplies,
        restorePendingCapabilityReplies,
      },
      () => {
        if (
          authorityId !== null &&
          this.capabilityReplyAuthorities.get(authorityId) === listener
        ) {
          this.capabilityReplyAuthorities.delete(authorityId);
        }
        for (const pendingId of frame.pendingCapabilityReplyAuthorityIdsToClear) {
          if (this.capabilityReplyAuthorities.get(pendingId) === listener) {
            this.capabilityReplyAuthorities.delete(pendingId);
          }
        }
      },
    );
  }

  private releaseCapabilityReplyLeases(listener: TerminalOutputListener): void {
    const retainedAuthorityIds = this.retainedCapabilityReplyAuthorityIds();
    for (const [authorityId, lease] of this.capabilityReplyAuthorities) {
      if (lease !== listener) continue;
      if (retainedAuthorityIds.has(authorityId)) {
        this.capabilityReplyAuthorities.set(authorityId, null);
      } else {
        this.capabilityReplyAuthorities.delete(authorityId);
      }
    }
  }

  private pruneCapabilityReplyAuthorities(): void {
    const retainedAuthorityIds = this.retainedCapabilityReplyAuthorityIds();
    for (const [authorityId, lease] of this.capabilityReplyAuthorities) {
      if (lease === null && !retainedAuthorityIds.has(authorityId)) {
        this.capabilityReplyAuthorities.delete(authorityId);
      }
    }
    if (
      this.pendingCapabilityReplyAuthority &&
      !this.capabilityReplyAuthorities.has(
        this.pendingCapabilityReplyAuthority.id,
      )
    ) {
      this.pendingCapabilityReplyAuthority = null;
    }
  }

  private retainedCapabilityReplyAuthorityIds(): Set<number> {
    const retained = new Set<number>();
    for (const frame of this.replay) {
      if (frame.capabilityReplyAuthorityId !== null) {
        retained.add(frame.capabilityReplyAuthorityId);
      }
      if (frame.pendingCapabilityReplyAuthorityId !== null) {
        retained.add(frame.pendingCapabilityReplyAuthorityId);
      }
    }
    return retained;
  }

  private rejectPendingPrompts(
    error: Error,
    sentDeliveryIsUnknown = false,
  ): void {
    for (const pending of this.pendingPrompts.values()) {
      pending.reject(
        sentDeliveryIsUnknown && pending.sentSocket
          ? new TerminalPromptDeliveryUnknownError()
          : error,
      );
    }
    this.pendingPrompts.clear();
    this.patch({ pendingPromptCount: 0 });
    this.detachIfUnused();
  }

  private rejectPromptsSentOn(socket: WebSocket): void {
    const uncertain = [...this.pendingPrompts.entries()].filter(
      ([, pending]) => pending.sentSocket === socket,
    );
    if (uncertain.length === 0) return;

    const error = new TerminalPromptDeliveryUnknownError();
    let rejectedInitialPrompt = false;
    for (const [requestId, pending] of uncertain) {
      this.pendingPrompts.delete(requestId);
      rejectedInitialPrompt ||= pending.sentAsInitial;
      pending.reject(error);
    }
    if (rejectedInitialPrompt) {
      this.intent = { kind: "attach" };
      this.startDeferred?.reject(error);
      this.startDeferred = null;
    }
    this.patch({
      pendingPromptCount: this.pendingPrompts.size,
      error,
      retryable: false,
    });
  }

  private hasUnknownDeliveryError(): boolean {
    return (
      this.snapshot.get().error instanceof TerminalPromptDeliveryUnknownError
    );
  }

  private detachIfUnused(): void {
    if (this.outputListeners.size === 0 && this.pendingPrompts.size === 0) {
      this.disconnectView();
    }
  }

  private resetRendererReplay(): void {
    this.replay = [];
    this.capabilityReplyAuthorities.clear();
    this.capabilityQueryBoundaryScanner.reset();
    this.pendingCapabilityReplyAuthority = null;
    this.replayComplete = true;
    this.lastOutputSequence = 0;
    this.patch({
      sessionId: null,
      generation: null,
    });
    const reset: TerminalControllerOutputFrame = {
      kind: "reset",
      seq: 0,
      data: new Uint8Array(),
      allowCapabilityReplies: false,
      restorePendingCapabilityReplies: false,
    };
    for (const listener of this.outputListeners) listener(reset, () => {});
  }

  private patch(patch: Partial<TerminalControllerSnapshot>): void {
    this.snapshot.update((current) => ({ ...current, ...patch }));
  }
}

const controllerRegistry = new Map<string, TerminalController>();

export function getOrCreateTerminalController(
  orgSlug: string,
  threadId: string,
): TerminalController {
  const key = `${orgSlug}::${threadId}`;
  const existing = controllerRegistry.get(key);
  if (existing) return existing;

  const controller = new TerminalController(orgSlug, threadId, (unused) => {
    if (controllerRegistry.get(key) !== unused) return;
    unused.dispose();
    controllerRegistry.delete(key);
  });
  controllerRegistry.set(key, controller);
  return controller;
}
