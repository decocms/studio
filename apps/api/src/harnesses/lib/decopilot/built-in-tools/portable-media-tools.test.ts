import { describe, expect, it } from "bun:test";
import {
  assertUrlDoesNotResolvePrivate,
  fetchImageBytes,
  generateImageCore,
  validateExternalUrl,
} from "./portable-media-tools";

describe("validateExternalUrl", () => {
  it("rejects loopback", () => {
    expect(() => validateExternalUrl("https://127.0.0.1/x", false)).toThrow();
  });

  // fc00::/7 unique local addresses span fc00::/8 AND fd00::/8.
  it("rejects fc00::/8 unique local addresses, not just fd00::/8", () => {
    expect(() => validateExternalUrl("https://[fc00::1]/x", false)).toThrow();
    expect(() => validateExternalUrl("https://[fd00::1]/x", false)).toThrow();
  });

  it("allows a normal public https URL", () => {
    expect(() =>
      validateExternalUrl("https://example.com/image.png", false),
    ).not.toThrow();
  });
});

describe("assertUrlDoesNotResolvePrivate", () => {
  // The DNS-rebinding case validateExternalUrl's literal-hostname check misses.
  it("rejects a hostname whose DNS resolves to a private address", async () => {
    const resolveHost = async () => ["169.254.169.254"];
    await expect(
      assertUrlDoesNotResolvePrivate("https://evil.example/x", resolveHost),
    ).rejects.toThrow();
  });

  it("allows a hostname resolving only to public addresses", async () => {
    const resolveHost = async () => ["93.184.216.34"];
    await expect(
      assertUrlDoesNotResolvePrivate("https://example.com/x", resolveHost),
    ).resolves.toBeUndefined();
  });

  it("skips the DNS lookup for an IP literal — already vetted synchronously", async () => {
    const resolveHost = async (): Promise<string[]> => {
      throw new Error("resolveHost should not be called for an IP literal");
    };
    await expect(
      assertUrlDoesNotResolvePrivate("https://127.0.0.1/x", resolveHost),
    ).resolves.toBeUndefined();
  });
});

describe("fetchImageBytes", () => {
  it("times out instead of hanging forever on an unresponsive reference-image host", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;

    try {
      await expect(
        // IP literal skips the DNS-rebinding check's real lookup.
        fetchImageBytes("https://93.184.216.34/reference.png", {}),
      ).rejects.toThrow(/timed out/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("generateImageCore", () => {
  it("times out instead of hanging forever on an unresponsive image provider", async () => {
    const originalTimeout = AbortSignal.timeout;
    // Stub out the real 120s wait with an already-aborted signal.
    AbortSignal.timeout = (() => {
      const controller = new AbortController();
      controller.abort(new DOMException("timed out", "TimeoutError"));
      return controller.signal;
    }) as typeof AbortSignal.timeout;

    const doGenerate = (opts: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });

    try {
      await expect(
        generateImageCore(
          { prompt: "a cat wearing a hat" },
          {
            provider: {
              aiSdk: {
                imageModel: () =>
                  ({ doGenerate }) as unknown as ReturnType<
                    Parameters<
                      typeof generateImageCore
                    >[1]["provider"]["aiSdk"]["imageModel"]
                  >,
              },
            },
            imageModelInfo: { id: "test-model" },
          },
        ),
      ).rejects.toThrow(/timed out/);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  });
});
