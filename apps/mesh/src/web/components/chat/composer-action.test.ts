import { describe, expect, it } from "bun:test";
import { resolveComposerAction } from "./composer-action";

describe("resolveComposerAction", () => {
  it("sends when there is a draft, even while a run streams (enqueue)", () => {
    expect(
      resolveComposerAction({
        hasDraft: true,
        isStreaming: true,
        isRunInProgress: false,
      }),
    ).toBe("send");
  });

  it("sends when there is a draft and a hosted run is in progress", () => {
    expect(
      resolveComposerAction({
        hasDraft: true,
        isStreaming: false,
        isRunInProgress: true,
      }),
    ).toBe("send");
  });

  it("sends when there is a draft and nothing is running", () => {
    expect(
      resolveComposerAction({
        hasDraft: true,
        isStreaming: false,
        isRunInProgress: false,
      }),
    ).toBe("send");
  });

  it("offers stop when streaming with no draft", () => {
    expect(
      resolveComposerAction({
        hasDraft: false,
        isStreaming: true,
        isRunInProgress: false,
      }),
    ).toBe("stop");
  });

  it("offers stop when a hosted run is in progress with no draft", () => {
    expect(
      resolveComposerAction({
        hasDraft: false,
        isStreaming: false,
        isRunInProgress: true,
      }),
    ).toBe("stop");
  });

  it("is disabled when idle with no draft", () => {
    expect(
      resolveComposerAction({
        hasDraft: false,
        isStreaming: false,
        isRunInProgress: false,
      }),
    ).toBe("disabled");
  });
});
