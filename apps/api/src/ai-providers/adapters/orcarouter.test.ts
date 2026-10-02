import { afterEach, describe, expect, test } from "bun:test";
import { orcarouterAdapter } from "./orcarouter";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("orcarouterAdapter", () => {
  test("defines correct provider metadata", () => {
    expect(orcarouterAdapter.info.id).toBe("orcarouter");
    expect(orcarouterAdapter.info.name).toBe("OrcaRouter");
    expect(orcarouterAdapter.supportedMethods).toEqual(["api-key"]);
  });

  describe("listModels", () => {
    test("sends Authorization header when apiKey is provided", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = (async (
        _url: unknown,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const provider = orcarouterAdapter.create("sk-orca-test-key");
      await provider.listModels();

      expect(capturedHeaders?.get("Authorization")).toBe(
        "Bearer sk-orca-test-key",
      );
    });

    test("omits Authorization header when apiKey is empty", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = (async (
        _url: unknown,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const provider = orcarouterAdapter.create("");
      await provider.listModels();

      expect(capturedHeaders?.has("Authorization")).toBe(false);
    });

    test("maps models with full metadata, capability remapping, and limits", async () => {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "anthropic/claude-fable-5",
                name: "Anthropic: Claude Fable 5",
                description: "Mythos-class model",
                context_length: 1_000_000,
                max_completion_tokens: 128_000,
                architecture: {
                  input_modalities: ["text", "image", "file"],
                  output_modalities: ["text", "image"],
                },
                top_provider: {
                  context_length: 1_000_000,
                  max_completion_tokens: 128_000,
                },
                pricing: {
                  prompt: "0.0000100000",
                  completion: "0.0000500000",
                },
              },
              {
                id: "orcarouter/free",
                object: "model",
                // No name, description, pricing, architecture, or limits
              },
              {
                id: "custom/no-limit",
                name: "Custom Model",
                context_length: 8192,
                max_completion_tokens: 8192, // reportedMaxOut == contextWindow -> should be null
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      const provider = orcarouterAdapter.create("key");
      const models = await provider.listModels();

      expect(models).toHaveLength(3);

      // Full model mapping check
      const fable = models[0]!;
      expect(fable.providerId).toBe("orcarouter");
      expect(fable.modelId).toBe("anthropic/claude-fable-5");
      expect(fable.title).toBe("Anthropic: Claude Fable 5");
      expect(fable.description).toBe("Mythos-class model");
      expect(fable.capabilities).toEqual([
        "text",
        "vision",
        "file",
        "image",
      ] as any);
      expect(fable.limits).toEqual({
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      });
      expect(fable.costs).toEqual({
        input: 0.00001,
        output: 0.00005,
      });

      // Minimal model check (e.g. orcarouter/free)
      const free = models[1]!;
      expect(free.modelId).toBe("orcarouter/free");
      expect(free.title).toBe("orcarouter/free");
      expect(free.description).toBeNull();
      expect(free.capabilities).toEqual([]);
      expect(free.limits).toEqual({
        contextWindow: 0,
        maxOutputTokens: null,
      });
      expect(free.costs).toBeNull();

      // Model where reportedMaxOut == contextWindow (maxOutputTokens should be clamped to null)
      const noLimit = models[2]!;
      expect(noLimit.limits).toEqual({
        contextWindow: 8192,
        maxOutputTokens: null,
      });
    });

    test("throws descriptive error when fetch fails", async () => {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response("Internal Server Error", { status: 500 });
      }) as unknown as typeof fetch;

      const provider = orcarouterAdapter.create("key");
      expect(provider.listModels()).rejects.toThrow(
        "OrcaRouter listModels failed: 500",
      );
    });
  });
});
