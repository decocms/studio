import { describe, expect, it } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type {
  ResearchJob,
  ResearchParams,
} from "@/harnesses/lib/decopilot/built-in-tools/web-search";
import { taskRunContextStore } from "../task-board/task-run-context";
import { chatToolContext } from "./test-helpers";
import {
  DEEP_RESEARCH,
  driveResearch,
  ResearchStalledError,
  WEB_SEARCH,
} from "./web-search";

const RESULT = {
  text: "the answer",
  citations: [],
  usage: { inputTokens: 1, outputTokens: 2 },
};

function jobOf(
  steps: Array<string | "hang">,
  seen: ResearchParams[] = [],
): ResearchJob {
  return async function* (params) {
    seen.push(params);
    for (const step of steps) {
      if (step === "hang") {
        await new Promise((_, reject) =>
          params.abortSignal?.addEventListener("abort", () =>
            reject(params.abortSignal?.reason),
          ),
        );
      }
      yield { progress: step };
    }
    return RESULT;
  };
}

describe("driveResearch", () => {
  it("relays every step as progress and returns the result", async () => {
    const sent: string[] = [];
    const result = await driveResearch(
      jobOf(["first", "second"]),
      { query: "q", taskId: "thrd_1", toolCallId: "toolu_1" },
      { progress: async (message) => void sent.push(message) },
    );
    expect(sent).toEqual(["first", "second"]);
    expect(result).toEqual(RESULT);
  });

  it("aborts the job once it stops making progress", async () => {
    const seen: ResearchParams[] = [];
    await expect(
      driveResearch(
        jobOf(["first", "hang"], seen),
        { query: "q", taskId: "thrd_1", toolCallId: "toolu_1" },
        undefined,
        20,
      ),
    ).rejects.toBeInstanceOf(ResearchStalledError);
    expect(seen[0]?.abortSignal?.aborted).toBe(true);
  });

  // Bounded on silence, not on wall-clock.
  it("does not stop a job that keeps reporting, however long it runs", async () => {
    const steps = Array.from({ length: 10 }, (_, i) => `step ${i}`);
    const slow: ResearchJob = async function* () {
      for (const step of steps) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield { progress: step };
      }
      return RESULT;
    };
    await expect(
      driveResearch(
        slow,
        { query: "q", taskId: "t", toolCallId: "c" },
        undefined,
        40,
      ),
    ).resolves.toEqual(RESULT);
  });

  it("passes the client's cancellation to the job", async () => {
    const client = new AbortController();
    const seen: ResearchParams[] = [];
    const running = driveResearch(
      jobOf(["hang"], seen),
      { query: "q", taskId: "t", toolCallId: "c" },
      { signal: client.signal },
    );
    client.abort(new Error("client went away"));
    await expect(running).rejects.toThrow("client went away");
  });

  it("keeps going when a progress notification cannot be sent", async () => {
    const result = await driveResearch(
      jobOf(["first"]),
      { query: "q", taskId: "t", toolCallId: "c" },
      {
        progress: async () => {
          throw new Error("transport closed");
        },
      },
    );
    expect(result).toEqual(RESULT);
  });
});

function contextWithSearchModel(models: string[]) {
  return chatToolContext({
    aiProviders: {
      listModels: async () => [],
      activate: async () => ({
        info: { id: "openrouter" },
        aiSdk: {
          languageModel: (modelId: string) => {
            models.push(modelId);
            return new MockLanguageModelV4({
              doStream: async () => ({
                stream: simulateReadableStream({
                  chunks: [
                    { type: "text-start", id: "t" },
                    { type: "text-delta", id: "t", delta: "Paris " },
                    { type: "text-delta", id: "t", delta: "is the capital." },
                    { type: "text-end", id: "t" },
                    {
                      type: "finish",
                      finishReason: { unified: "stop", raw: "stop" },
                      usage: {
                        inputTokens: {
                          total: 3,
                          noCache: 3,
                          cacheRead: 0,
                          cacheWrite: 0,
                        },
                        outputTokens: { total: 4, text: 4, reasoning: 0 },
                      },
                    },
                  ],
                }),
              }),
            });
          },
        },
      }),
    },
  });
}

describe("web_search / deep_research", () => {
  it("web_search answers on the org's web_search tier, with progress", async () => {
    const models: string[] = [];
    const sent: string[] = [];
    const result = await WEB_SEARCH.handler(
      { query: "capital of France" },
      contextWithSearchModel(models),
      { progress: async (message) => void sent.push(message) },
    );
    expect(models).toEqual(["search-model"]);
    expect(result).toMatchObject({
      success: true,
      content: "Paris is the capital.",
      query: "capital of France",
    });
    expect(sent.at(-1)).toBe("Paris is the capital.");
  });

  it("deep_research uses the deep_research tier on the path's thread", async () => {
    const models: string[] = [];
    const result = await taskRunContextStore.run({ threadId: "thrd_1" }, () =>
      DEEP_RESEARCH.handler(
        { query: "capital of France" },
        contextWithSearchModel(models),
      ),
    );
    expect(models).toEqual(["research-model"]);
    expect(result.content).toBe("Paris is the capital.");
  });

  it("deep_research needs a thread to record its job against", async () => {
    await expect(
      DEEP_RESEARCH.handler(
        { query: "capital of France" },
        contextWithSearchModel([]),
      ),
    ).rejects.toThrow(/thread's MCP endpoint/);
  });
});
