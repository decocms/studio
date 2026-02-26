import { describe, it, expect, mock } from "bun:test";
import { NatsStreamBuffer } from "./nats-stream-buffer";
import { NoOpStreamBuffer } from "./stream-buffer";

describe("NoOpStreamBuffer", () => {
  it("relay returns the input stream unchanged", () => {
    const buffer = new NoOpStreamBuffer();
    const stream = new ReadableStream();
    expect(buffer.relay(stream)).toBe(stream);
  });

  it("createReplayStream returns null", async () => {
    const buffer = new NoOpStreamBuffer();
    expect(await buffer.createReplayStream()).toBeNull();
  });

  it("purge and teardown are no-ops (no throw)", () => {
    const buffer = new NoOpStreamBuffer();
    expect(() => buffer.purge()).not.toThrow();
    expect(() => buffer.teardown()).not.toThrow();
  });
});

describe("NatsStreamBuffer", () => {
  it("init is a no-op when getConnection returns null", async () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => null,
      getJetStream: () => null,
    });
    await expect(buffer.init()).resolves.toBeUndefined();
  });

  it("relay passes through when JetStream is unavailable", async () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => null,
      getJetStream: () => null,
    });

    const chunks = [{ type: "text", value: "hello" }];
    const input = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

    const output = buffer.relay(input, "thread-1");
    const reader = output.getReader();
    const result = await reader.read();

    expect(result.value).toEqual(chunks[0]);
  });

  it("createReplayStream returns null when JetStream is unavailable", async () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => null,
      getJetStream: () => null,
    });
    expect(await buffer.createReplayStream("any")).toBeNull();
  });

  it("purge is a no-op when jsm is not initialized (no throw)", () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => null,
      getJetStream: () => null,
    });
    expect(() => buffer.purge("any")).not.toThrow();
  });

  it("teardown clears references", () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => null,
      getJetStream: () => null,
    });
    expect(() => buffer.teardown()).not.toThrow();
  });

  it("init creates or updates stream when connection is available", async () => {
    const streamInfoMock = mock(() => Promise.resolve({}));
    const streamUpdateMock = mock(() => Promise.resolve({}));
    const streamAddMock = mock(() => Promise.resolve({}));

    const mockJsm = {
      streams: {
        info: streamInfoMock,
        update: streamUpdateMock,
        add: streamAddMock,
      },
    };

    const mockNc = {
      jetstreamManager: mock(() => Promise.resolve(mockJsm)),
    };

    const mockJs = {} as never;

    const buffer = new NatsStreamBuffer({
      getConnection: () => mockNc as never,
      getJetStream: () => mockJs,
    });

    await buffer.init();

    expect(mockNc.jetstreamManager).toHaveBeenCalledTimes(1);
    expect(streamInfoMock).toHaveBeenCalledWith("DECOPILOT_STREAMS");
    expect(streamUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("init falls back to add when info throws", async () => {
    const streamInfoMock = mock(() =>
      Promise.reject(new Error("stream not found")),
    );
    const streamUpdateMock = mock(() => Promise.resolve({}));
    const streamAddMock = mock(() => Promise.resolve({}));

    const mockJsm = {
      streams: {
        info: streamInfoMock,
        update: streamUpdateMock,
        add: streamAddMock,
      },
    };

    const mockNc = {
      jetstreamManager: mock(() => Promise.resolve(mockJsm)),
    };

    const buffer = new NatsStreamBuffer({
      getConnection: () => mockNc as never,
      getJetStream: () => ({}) as never,
    });

    await buffer.init();

    expect(streamAddMock).toHaveBeenCalledTimes(1);
  });
});
