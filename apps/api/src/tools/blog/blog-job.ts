import { agentSandboxEnabled } from "@/settings";
import { getUserId, type StudioContext } from "../../core/studio-context";
import { taskRunContextStore } from "../task-board/task-run-context";

/** The chat whose run is calling, or null for a person; a sandboxed run reaches Studio on its thread's MCP endpoint. */
export function callerRunThread(ctx: StudioContext): string | null {
  return (
    taskRunContextStore.getStore()?.threadId ?? ctx.metadata?.threadId ?? null
  );
}

/** The person starting a blog job: a run, a deployment without a sandbox or a caller without a user cannot. */
export function blogJobStarter(ctx: StudioContext, what: string): string {
  if (callerRunThread(ctx)) {
    throw new Error(`A run cannot start ${what}; a person does.`);
  }
  if (!agentSandboxEnabled()) {
    throw new Error(`This deployment has no sandbox to run ${what} in.`);
  }
  const userId = getUserId(ctx);
  if (!userId) throw new Error(`Starting ${what} needs a person.`);
  return userId;
}
