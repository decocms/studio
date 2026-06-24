import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  openMcpSource,
  type DecopilotHttpMcpSource,
  type OpenMcpSourceOptions,
} from "../../sources";
import type { BackgroundDispatcher } from "./backgroundable";

/**
 * Desktop-daemon `BackgroundDispatcher`: the daemon has no DBOS, so `start()`
 * enqueues the work on the cluster by calling the `THREAD_BACKGROUND_TOOL_START`
 * management tool over the studio `/mcp/self` endpoint — reusing the run's MCP
 * credentials instead of a bespoke HTTP route. Auth = the run's bearer; the
 * fence token (an input) must match the thread's active run.
 */
export interface McpBackgroundDispatcherOptions {
  /** Studio management MCP, e.g. `${apiBase}/mcp/self`, with the run's headers. */
  source: DecopilotHttpMcpSource;
  /** Thread the job belongs to. */
  threadId: string;
  /** Run fence token — must match the cluster's active run fence. */
  fenceToken: string;
  /** Thread/model snapshot the cluster needs to rebuild the reaction turn. */
  snapshot: {
    agentId: string;
    temperature: number;
    toolApprovalLevel: string;
    branch: string | null;
  };
  /** Injectable for tests (defaults to the real Streamable-HTTP transport). */
  openHttp?: OpenMcpSourceOptions["openHttp"];
}

export function createMcpBackgroundDispatcher(
  options: McpBackgroundDispatcherOptions,
): BackgroundDispatcher {
  return {
    start: async ({ toolName, input, toolCallId }) => {
      const { client, close } = await openMcpSource(options.source, {
        clientInfo: { name: "decopilot-desktop-bg", version: "1" },
        openHttp: options.openHttp,
      });
      try {
        const result = await (client as Client).callTool({
          name: "THREAD_BACKGROUND_TOOL_START",
          arguments: {
            threadId: options.threadId,
            fenceToken: options.fenceToken,
            toolName,
            input,
            toolCallId,
            ...options.snapshot,
          },
        });
        if (result.isError) {
          const detail =
            Array.isArray(result.content) && result.content[0]?.type === "text"
              ? result.content[0].text
              : "";
          throw new Error(`background-tool enqueue failed: ${detail}`);
        }
        const jobId = (
          result.structuredContent as { jobId?: string } | undefined
        )?.jobId;
        if (!jobId) {
          throw new Error("background-tool enqueue returned no jobId");
        }
        return { jobId };
      } finally {
        await close();
      }
    },
  };
}
