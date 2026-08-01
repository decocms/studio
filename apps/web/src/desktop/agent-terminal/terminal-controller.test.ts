import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  TerminalController,
  TerminalPromptDeliveryUnknownError,
} from "./terminal-controller";

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = TestWebSocket.CONNECTING;
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

function frames(socket: TestWebSocket): Array<{ type?: string }> {
  return socket.sent.map((raw) => JSON.parse(raw) as { type?: string });
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
