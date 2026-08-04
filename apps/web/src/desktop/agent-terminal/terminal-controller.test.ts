import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  TerminalController,
  TerminalPromptDeliveryUnknownError,
  terminalReplayRequiresAuthorityPrune,
} from "./terminal-controller";
import { createTerminalParserCapabilityQueryAuthority } from "./terminal-capability-replies";

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = TestWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;

  constructor(readonly url: string | URL) {
    TestWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  receiveBinary(data: ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  remoteClose(): void {
    this.close();
  }
}

const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

function frames(socket: TestWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function runningReady(harnessId: "claude-code" | "codex") {
  return {
    type: "ready",
    sessionId: "terminal-session",
    generation: "thread-generation",
    harnessId,
    physicalState: "running",
    logicalState: "idle",
    lastSeq: 0,
  };
}

beforeEach(() => {
  TestWebSocket.instances = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL("https://studio.test/org/chats/thread") },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: TestWebSocket,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: originalWebSocket,
  });
});

describe("native terminal prompt delivery", () => {
  test("uses user-facing copy when a chat closes before an unsent prompt", async () => {
    const controller = new TerminalController("org", "thread");
    const submitted = controller.submitPrompt("run it", "request-disposed");

    controller.dispose();

    await expect(submitted).rejects.toThrow(
      "The chat closed before your message was sent. Reopen it and try again.",
    );
  });

  test("keeps process exit codes out of the user-facing error", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    controller.ensureAttached("codex");

    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    socket.receive({
      type: "exit",
      code: 137,
      expected: false,
    });

    expect(controller.snapshot.get().error?.message).toBe(
      "The coding agent stopped unexpectedly. Reopen the chat and try again.",
    );
    expect(controller.snapshot.get().error?.message).not.toContain("137");

    unsubscribe();
    controller.dispose();
  });

  test("does not resend an initial prompt after an ambiguous disconnect", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    const start = controller.start("claude-code", {
      initialPrompt: "make the change",
      requestId: "request-1",
    });

    const first = TestWebSocket.instances[0]!;
    first.open();
    expect(frames(first).map((frame) => frame.type)).toEqual(["start"]);
    expect(frames(first)[0]).toMatchObject({
      outputAcks: true,
      binaryOutput: true,
    });

    first.remoteClose();
    await expect(start).rejects.toBeInstanceOf(
      TerminalPromptDeliveryUnknownError,
    );

    controller.retry();
    const replacement = TestWebSocket.instances[1]!;
    replacement.open();
    expect(frames(replacement).map((frame) => frame.type)).toEqual(["attach"]);

    unsubscribe();
    controller.dispose();
  });

  test("reconnects for replay without resending a submitted prompt", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    controller.ensureAttached("codex");

    const first = TestWebSocket.instances[0]!;
    first.open();
    first.receive(runningReady("codex"));
    const submitted = controller.submitPrompt("run it", "request-2");
    expect(frames(first).map((frame) => frame.type)).toEqual([
      "attach",
      "resize",
      "submit_prompt",
    ]);

    first.remoteClose();
    await expect(submitted).rejects.toBeInstanceOf(
      TerminalPromptDeliveryUnknownError,
    );

    controller.retry();
    const replacement = TestWebSocket.instances[1]!;
    replacement.open();
    expect(frames(replacement).map((frame) => frame.type)).toEqual(["attach"]);

    unsubscribe();
    controller.dispose();
  });

  test("correlates a stale-writer rejection and stops its reconnect loop", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    controller.ensureAttached("codex");

    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    const first = controller.submitPrompt("first", "request-a");
    const second = controller.submitPrompt("second", "request-b");
    void second.catch(() => {});
    socket.receive({
      type: "error",
      code: "stale_attachment",
      message: "a newer window controls this terminal",
      retryable: true,
      requestId: "request-a",
    });

    await expect(first).rejects.toThrow(
      "a newer window controls this terminal",
    );
    expect(controller.snapshot.get()).toMatchObject({
      connection: "disconnected",
      pendingPromptCount: 1,
    });
    expect(TestWebSocket.instances).toHaveLength(1);

    unsubscribe();
    controller.dispose();
  });
});

describe("native terminal output flow control", () => {
  test("marks a finite restore boundary for server and remount history", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const delivered: Array<{
      kind: "output" | "reset";
      seq: number;
      restoreUntilSeq: number | null;
    }> = [];
    const unsubscribe = controller.subscribeOutput((frame) => {
      delivered.push({
        kind: frame.kind,
        seq: frame.seq,
        restoreUntilSeq: frame.restoreUntilSeq,
      });
    });
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive({ ...runningReady("codex"), lastSeq: 10 });
    socket.receive({ type: "reset", seq: 2, data: "" });
    socket.receive({ type: "output", seq: 5, data: "old", replay: true });
    socket.receive({ type: "output", seq: 10, data: "state", replay: true });
    socket.receive({ type: "output", seq: 14, data: "live", replay: false });

    expect(delivered).toEqual([
      { kind: "reset", seq: 2, restoreUntilSeq: 10 },
      { kind: "output", seq: 5, restoreUntilSeq: 10 },
      { kind: "output", seq: 10, restoreUntilSeq: 10 },
      { kind: "output", seq: 14, restoreUntilSeq: null },
    ]);

    unsubscribe();
    const remounted: Array<{ seq: number; restoreUntilSeq: number | null }> =
      [];
    const unsubscribeRemount = controller.subscribeOutput((frame) => {
      remounted.push({
        seq: frame.seq,
        restoreUntilSeq: frame.restoreUntilSeq,
      });
    });
    expect(remounted).toEqual([
      { seq: 2, restoreUntilSeq: 14 },
      { seq: 5, restoreUntilSeq: 14 },
      { seq: 10, restoreUntilSeq: 14 },
      { seq: 14, restoreUntilSeq: 14 },
    ]);

    unsubscribeRemount();
    controller.dispose();
  });

  test("sends cumulative output ACKs only for received parsed sequences", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const delivered: number[] = [];
    const unsubscribe = controller.subscribeOutput((frame) => {
      delivered.push(frame.seq);
    });
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    expect(frames(socket)[0]).toMatchObject({
      type: "attach",
      outputAcks: true,
    });
    socket.receive(runningReady("codex"));
    socket.receive({ type: "output", seq: 5, data: "hello", replay: false });

    expect(delivered).toEqual([5]);
    controller.acknowledgeOutput(5);
    controller.acknowledgeOutput(5);
    controller.acknowledgeOutput(4);
    controller.acknowledgeOutput(6);
    expect(
      frames(socket).filter((frame) => frame.type === "ack_output"),
    ).toEqual([{ type: "ack_output", processedSeq: 5 }]);

    unsubscribe();
    controller.dispose();
  });

  test("negotiates and accepts binary terminal output", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const delivered: Array<{ seq: number; data: number[] }> = [];
    const unsubscribe = controller.subscribeOutput((frame) => {
      delivered.push({ seq: frame.seq, data: [...frame.data] });
    });
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    expect(socket.binaryType).toBe("arraybuffer");
    socket.open();
    expect(frames(socket)[0]).toMatchObject({
      type: "attach",
      binaryOutput: true,
    });
    socket.receive(runningReady("codex"));

    const raw = new ArrayBuffer(11);
    const view = new DataView(raw);
    view.setUint8(0, 1);
    view.setUint32(5, 2);
    new Uint8Array(raw, 9).set([0xff, 0x9b]);
    socket.receiveBinary(raw);

    expect(delivered).toEqual([{ seq: 2, data: [0xff, 0x9b] }]);
    unsubscribe();
    controller.dispose();
  });
});

describe("native terminal input flow control", () => {
  test("keeps the first input immediate and coalesces a same-turn burst", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));

    controller.input("first");
    controller.input("second");
    controller.input("third");
    expect(frames(socket).filter((frame) => frame.type === "input")).toEqual([
      { type: "input", data: "first" },
    ]);

    await Promise.resolve();
    expect(frames(socket).filter((frame) => frame.type === "input")).toEqual([
      { type: "input", data: "first" },
      { type: "input", data: "secondthird" },
    ]);

    unsubscribe();
    controller.dispose();
  });

  test("flushes parser replies before their cumulative output ACK", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    socket.receive({ type: "output", seq: 5, data: "hello", replay: false });

    controller.input("reply-one");
    controller.input("reply-two");
    controller.acknowledgeOutput(5);

    expect(
      frames(socket).filter(
        (frame) => frame.type === "input" || frame.type === "ack_output",
      ),
    ).toEqual([
      { type: "input", data: "reply-one" },
      { type: "input", data: "reply-two" },
      { type: "ack_output", processedSeq: 5 },
    ]);

    unsubscribe();
    controller.dispose();
  });

  test("drops queued input when its socket disconnects", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const unsubscribe = controller.subscribeOutput(() => {});
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));

    controller.input("delivered");
    controller.input("stale");
    socket.remoteClose();
    await Promise.resolve();

    expect(frames(socket).filter((frame) => frame.type === "input")).toEqual([
      { type: "input", data: "delivered" },
    ]);

    unsubscribe();
    controller.dispose();
  });
});

describe("native terminal capability reply authority", () => {
  test("prunes retained authorities only after reset or replay eviction", () => {
    const retained = {};
    expect(
      terminalReplayRequiresAuthorityPrune("output", retained, retained),
    ).toBeFalse();
    expect(
      terminalReplayRequiresAuthorityPrune("output", retained, {}),
    ).toBeTrue();
    expect(
      terminalReplayRequiresAuthorityPrune("reset", retained, retained),
    ).toBeTrue();
  });

  test("restores only an incomplete query authority across remount", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const initialAuthority = createTerminalParserCapabilityQueryAuthority();
    const unsubscribeInitial = controller.subscribeOutput((frame, ack) => {
      initialAuthority.observe(frame.data, frame.allowCapabilityReplies);
      if (frame.restorePendingCapabilityReplies) {
        initialAuthority.restorePendingReplyAuthority();
      }
      ack();
    });
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    socket.receive({ type: "output", seq: 5, data: "\x1b[", replay: false });
    unsubscribeInitial();

    const remountAuthority = createTerminalParserCapabilityQueryAuthority();
    const remountedFrames: Array<{
      allow: boolean;
      restorePending: boolean;
      sequence: number;
    }> = [];
    const unsubscribeRemount = controller.subscribeOutput((frame, ack) => {
      remountedFrames.push({
        allow: frame.allowCapabilityReplies,
        restorePending: frame.restorePendingCapabilityReplies,
        sequence: frame.seq,
      });
      remountAuthority.observe(frame.data, frame.allowCapabilityReplies);
      if (frame.restorePendingCapabilityReplies) {
        remountAuthority.restorePendingReplyAuthority();
      }
      ack();
    });
    expect(remountedFrames).toEqual([
      { allow: false, restorePending: true, sequence: 5 },
    ]);

    const replacement = TestWebSocket.instances[1]!;
    replacement.open();
    replacement.receive({ ...runningReady("codex"), lastSeq: 5 });
    replacement.receive({
      type: "output",
      seq: 10,
      data: "c",
      replay: false,
    });
    expect(remountAuthority.takeReplyAuthority({ kind: "da1" })).toBeTrue();
    unsubscribeRemount();

    const settledAuthority = createTerminalParserCapabilityQueryAuthority();
    const unsubscribeSettled = controller.subscribeOutput((frame, ack) => {
      settledAuthority.observe(frame.data, frame.allowCapabilityReplies);
      if (frame.restorePendingCapabilityReplies) {
        settledAuthority.restorePendingReplyAuthority();
      }
      ack();
    });
    expect(settledAuthority.takeReplyAuthority({ kind: "da1" })).toBeFalse();

    unsubscribeSettled();
    controller.dispose();
  });

  test("restores one reply authority across multiple incomplete replay chunks", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const initialAuthority = createTerminalParserCapabilityQueryAuthority();
    const unsubscribeInitial = controller.subscribeOutput((frame, ack) => {
      initialAuthority.observe(frame.data, frame.allowCapabilityReplies);
      if (frame.restorePendingCapabilityReplies) {
        initialAuthority.restorePendingReplyAuthority();
      }
      ack();
    });
    controller.ensureAttached("codex");
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    socket.receive({ type: "output", seq: 5, data: "\x1b[", replay: false });
    socket.receive({ type: "output", seq: 10, data: "0", replay: false });
    unsubscribeInitial();

    const remountAuthority = createTerminalParserCapabilityQueryAuthority();
    const restoredBySequence: number[] = [];
    const unsubscribeRemount = controller.subscribeOutput((frame, ack) => {
      remountAuthority.observe(frame.data, frame.allowCapabilityReplies);
      if (frame.restorePendingCapabilityReplies) {
        restoredBySequence.push(frame.seq);
        remountAuthority.restorePendingReplyAuthority();
      }
      ack();
    });
    expect(restoredBySequence).toEqual([5, 10]);

    const replacement = TestWebSocket.instances[1]!;
    replacement.open();
    replacement.receive({ ...runningReady("codex"), lastSeq: 10 });
    replacement.receive({ type: "output", seq: 15, data: "c", replay: false });
    expect(remountAuthority.takeReplyAuthority({ kind: "da1" })).toBeTrue();
    expect(remountAuthority.takeReplyAuthority({ kind: "da1" })).toBeFalse();

    unsubscribeRemount();
    controller.dispose();
  });

  test("releases an unacknowledged live-frame lease across a StrictMode remount", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const started = controller.start("codex", {
      initialPrompt: "start",
      requestId: "strict-startup-request",
    });
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    socket.receive({
      type: "output",
      seq: 5,
      data: "\x1b[c",
      replay: false,
    });

    let staleAcknowledge = () => {};
    let firstAllowed = false;
    const unsubscribeProbe = controller.subscribeOutput(
      (frame, acknowledgeCapabilityReplies) => {
        firstAllowed = frame.allowCapabilityReplies;
        staleAcknowledge = acknowledgeCapabilityReplies;
      },
    );
    expect(firstAllowed).toBeTrue();
    unsubscribeProbe();

    let remountAcknowledge = () => {};
    let remountAllowed = false;
    const unsubscribeRemount = controller.subscribeOutput(
      (frame, acknowledgeCapabilityReplies) => {
        remountAllowed = frame.allowCapabilityReplies;
        remountAcknowledge = acknowledgeCapabilityReplies;
      },
    );
    expect(remountAllowed).toBeTrue();
    staleAcknowledge();
    remountAcknowledge();
    unsubscribeRemount();

    let settledReplayAllowed = true;
    const unsubscribeSettled = controller.subscribeOutput((frame) => {
      settledReplayAllowed = frame.allowCapabilityReplies;
    });
    expect(settledReplayAllowed).toBeFalse();

    socket.receive({
      type: "prompt_accepted",
      requestId: "strict-startup-request",
    });
    await started;
    unsubscribeSettled();
    controller.dispose();
  });

  test("allows fresh startup replay once and strips authority from remount replay", async () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const started = controller.start("codex", {
      initialPrompt: "start",
      requestId: "startup-request",
    });

    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive(runningReady("codex"));
    socket.receive({
      type: "output",
      seq: 5,
      data: "\x1b]10;?\x1b\\",
      replay: true,
    });

    const firstFrames: Array<{
      seq: number;
      allowCapabilityReplies: boolean;
    }> = [];
    let acknowledgeFirst = () => {};
    const unsubscribeFirst = controller.subscribeOutput(
      (frame, acknowledgeCapabilityReplies) => {
        firstFrames.push({
          seq: frame.seq,
          allowCapabilityReplies: frame.allowCapabilityReplies,
        });
        acknowledgeFirst = acknowledgeCapabilityReplies;
      },
    );
    expect(firstFrames).toEqual([{ seq: 5, allowCapabilityReplies: true }]);
    acknowledgeFirst();

    const remountedFrames: Array<{
      seq: number;
      allowCapabilityReplies: boolean;
    }> = [];
    const unsubscribeRemount = controller.subscribeOutput((frame) => {
      remountedFrames.push({
        seq: frame.seq,
        allowCapabilityReplies: frame.allowCapabilityReplies,
      });
    });
    expect(remountedFrames).toEqual([
      { seq: 5, allowCapabilityReplies: false },
    ]);

    socket.receive({
      type: "output",
      seq: 10,
      data: "\x1b[14t",
      replay: false,
    });
    expect(firstFrames.at(-1)).toEqual({
      seq: 10,
      allowCapabilityReplies: true,
    });
    expect(remountedFrames.at(-1)).toEqual({
      seq: 10,
      allowCapabilityReplies: false,
    });
    acknowledgeFirst();
    socket.receive({
      type: "prompt_accepted",
      requestId: "startup-request",
    });
    await started;

    unsubscribeRemount();
    unsubscribeFirst();
    controller.dispose();
  });

  test("suppresses attach replay and does not re-authorize duplicate output after reconnect", () => {
    const controller = new TerminalController("org", "thread");
    controller.retain();
    const received: Array<{
      seq: number;
      allowCapabilityReplies: boolean;
    }> = [];
    const unsubscribe = controller.subscribeOutput((frame) => {
      received.push({
        seq: frame.seq,
        allowCapabilityReplies: frame.allowCapabilityReplies,
      });
    });
    controller.ensureAttached("codex");

    const first = TestWebSocket.instances[0]!;
    first.open();
    first.receive(runningReady("codex"));
    first.receive({ type: "output", seq: 5, data: "history", replay: true });
    first.receive({ type: "output", seq: 10, data: "live", replay: false });
    expect(received).toEqual([
      { seq: 5, allowCapabilityReplies: false },
      { seq: 10, allowCapabilityReplies: true },
    ]);

    first.remoteClose();
    controller.retry();
    const replacement = TestWebSocket.instances[1]!;
    replacement.open();
    replacement.receive({ ...runningReady("codex"), lastSeq: 15 });
    replacement.receive({
      type: "output",
      seq: 10,
      data: "duplicate",
      replay: true,
    });
    replacement.receive({
      type: "output",
      seq: 15,
      data: "missed while disconnected",
      replay: true,
    });
    expect(received).toEqual([
      { seq: 5, allowCapabilityReplies: false },
      { seq: 10, allowCapabilityReplies: true },
      { seq: 15, allowCapabilityReplies: false },
    ]);

    unsubscribe();
    controller.dispose();
  });
});
