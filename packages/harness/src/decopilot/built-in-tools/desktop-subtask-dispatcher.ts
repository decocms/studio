import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  openMcpSource,
  type DecopilotHttpMcpSource,
  type OpenMcpSourceOptions,
} from "../../sources";
import type { SubtaskRunResult } from "../run-core";
import type { BackgroundDispatcher } from "./backgroundable";

/**
 * Desktop `subtask` background dispatcher. Unlike `generate_image` (which has no
 * local sandbox and is enqueued onto the cluster), a subtask needs the daemon's
 * REAL sandbox + vm/fs tools — so it runs HERE, detached: `start()` kicks the
 * subagent off via `runSubtask` (the same closure the inline tool uses, full
 * context) WITHOUT awaiting it, returns a started handle so the turn doesn't
 * block, and — when the detached run finishes — delivers its report to the
 * cluster via the `THREAD_SUBTASK_DELIVER` tool over `/mcp/self` (persist nested
 * + react). The daemon process + sandbox outlive the turn, so the detached run
 * keeps going.
 *
 * NOTE: live token-streaming of the detached run is not wired yet — the panel
 * shows the report when it lands. Streaming needs a second per-job relay lane
 * (follow-up).
 */
export interface DesktopSubtaskDispatcherOptions {
  /** Studio management MCP (`/mcp/self`) with the run's headers — the deliver hop. */
  source: DecopilotHttpMcpSource;
  threadId: string;
  fenceToken: string;
  snapshot: {
    agentId: string;
    temperature: number;
    toolApprovalLevel: string;
    branch: string | null;
  };
  /** Runs the subagent locally on the daemon (real sandbox) → its result. */
  runSubtask: (
    prompt: string,
    targetAgentId: string | undefined,
    signal: AbortSignal,
  ) => Promise<SubtaskRunResult>;
  /** Injectable for tests (defaults to the real Streamable-HTTP transport). */
  openHttp?: OpenMcpSourceOptions["openHttp"];
  /** Injectable id generator (defaults to `bgtool:<threadId>:<uuid>`). */
  newJobId?: () => string;
}

export function createDesktopSubtaskDispatcher(
  options: DesktopSubtaskDispatcherOptions,
): BackgroundDispatcher {
  return {
    start: async ({ input }) => {
      const { prompt, agent_id } = (input ?? {}) as {
        prompt: string;
        agent_id?: string;
      };
      const jobId =
        options.newJobId?.() ??
        `bgtool:${options.threadId}:${crypto.randomUUID()}`;
      // Self-clone when no/own agent_id; otherwise delegate to that agent.
      const target =
        agent_id && agent_id !== options.snapshot.agentId
          ? agent_id
          : undefined;

      // Detached: do NOT await. The turn returns the started handle immediately;
      // the subagent runs in the daemon's sandbox and delivers when it finishes.
      void (async () => {
        let report = "";
        try {
          const result = await options.runSubtask(
            prompt,
            target,
            new AbortController().signal,
          );
          report = result.error
            ? `Subtask failed: ${result.error}`
            : (result.text ?? "");
        } catch (err) {
          report = `Subtask failed: ${(err as Error).message}`;
        }
        try {
          const { client, close } = await openMcpSource(options.source, {
            clientInfo: { name: "decopilot-desktop-subtask", version: "1" },
            openHttp: options.openHttp,
          });
          try {
            await (client as Client).callTool({
              name: "THREAD_SUBTASK_DELIVER",
              arguments: {
                threadId: options.threadId,
                fenceToken: options.fenceToken,
                jobId,
                report,
                ...options.snapshot,
              },
            });
          } finally {
            await close();
          }
        } catch (err) {
          console.error("[decopilot-desktop] subtask deliver failed", err);
        }
      })();

      return { jobId };
    },
  };
}
