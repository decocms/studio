import { describe, expect, test } from "bun:test";
import type { UIMessageStreamWriter } from "ai";
import type { ResearchParams, ResearchResult } from "../../harness-deps";
import { createWebSearchTool } from "./web-search";

function makeWriter(): {
  writer: UIMessageStreamWriter;
  events: Array<{ type: string; data?: unknown }>;
} {
  const events: Array<{ type: string; data?: unknown }> = [];
  const writer = {
    write: (part: { type: string; data?: unknown }) => {
      events.push(part);
    },
  } as unknown as UIMessageStreamWriter;
  return { writer, events };
}

describe("createWebSearchTool", () => {
  test("drives the researchJob async generator and returns its result", async () => {
    const { writer, events } = makeWriter();
    const progress: string[] = [];
    const seen: ResearchParams[] = [];
    async function* researchJob(
      params: ResearchParams,
    ): AsyncGenerator<{ progress: string }, ResearchResult> {
      seen.push(params);
      yield { progress: "searching" };
      yield { progress: "synthesizing" };
      return {
        text: `report for ${params.query}`,
        citations: [{ url: "https://a.example" }],
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    }
    const toolOutputMap = new Map<string, string>();
    const tool = createWebSearchTool(writer, {
      researchJob: async function* (p) {
        const gen = researchJob(p);
        let next = await gen.next();
        while (!next.done) {
          progress.push(next.value.progress);
          yield next.value;
          next = await gen.next();
        }
        return next.value;
      },
      toolOutputMap,
      taskId: "task-1",
    });

    const result = (await tool.execute!({ query: "typescript 6 release" }, {
      toolCallId: "tc1",
    } as never)) as {
      success: boolean;
      content?: string;
      citations?: unknown[];
    };

    expect(result.success).toBe(true);
    expect(result.content).toContain("report for typescript 6 release");
    expect(progress).toEqual(["searching", "synthesizing"]);
    // The driver forwards taskId + toolCallId into the hook params.
    expect(seen[0]?.taskId).toBe("task-1");
    expect(seen[0]?.toolCallId).toBe("tc1");
    // Progress chunks reach the UI; tool metadata is emitted on finish.
    expect(events.some((e) => e.type === "data-web-search")).toBe(true);
    expect(events.some((e) => e.type === "data-tool-metadata")).toBe(true);
    // The full text is registered for read_tool_output.
    expect(toolOutputMap.get("tc1")).toContain(
      "report for typescript 6 release",
    );
  });

  test("returns the offloaded blob shape (uri + preview) when the hook offloads", async () => {
    const { writer } = makeWriter();
    const tool = createWebSearchTool(writer, {
      // eslint-disable-next-line require-yield -- the offloaded path returns immediately, no progress
      researchJob: async function* () {
        return {
          text: "full report body",
          citations: [],
          usage: { inputTokens: 3, outputTokens: 4 },
          resultUri: "studio-storage://web-search/abc.md",
          preview: "full report...",
        };
      },
      toolOutputMap: new Map(),
      taskId: "task-2",
    });

    const result = (await tool.execute!({ query: "anything" }, {
      toolCallId: "tc2",
    } as never)) as {
      success: boolean;
      uri?: string;
      preview?: string;
      content?: string;
    };

    expect(result.success).toBe(true);
    expect(result.uri).toBe("studio-storage://web-search/abc.md");
    expect(result.preview).toBe("full report...");
    expect(result.content).toBeUndefined();
  });

  test("does not import StudioContext (no ctx/provider field)", () => {
    const { writer } = makeWriter();
    const tool = createWebSearchTool(writer, {
      // eslint-disable-next-line require-yield -- no-op hook for the shape assertion
      researchJob: async function* () {
        return {
          text: "",
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      toolOutputMap: new Map(),
      taskId: "task-3",
    });
    expect(typeof tool.execute).toBe("function");
  });
});
