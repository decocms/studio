import { describe, it, expect, mock } from "bun:test";
import { NatsStreamBuffer } from "./nats-stream-buffer";

describe("NatsStreamBuffer", () => {
  it("purge is a no-op when jsm is not initialized (no throw)", () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
    });
    expect(() => buffer.purge("any")).not.toThrow();
  });

  it("teardown clears references", () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
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
