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

/**
 * How long a requested run counts as running before its chat says so: the
 * gap between the claim and the run starting is a queue, not an idle card.
 */
const RUN_START_WINDOW_MS = 2 * 60_000;

/**
 * Whether an agent is already at work on a card or a campaign: its chat is running, or a run
 * was requested moments ago and has not started yet.
 */
export function runInFlight(
  run: { requestedAt?: string } | undefined,
  thread: { status?: string | null; run_started_at?: string | null } | null,
  now: number,
): boolean {
  if (thread?.status === "in_progress") return true;
  const requested = Date.parse(run?.requestedAt ?? "");
  if (!Number.isFinite(requested) || now - requested >= RUN_START_WINDOW_MS) {
    return false;
  }
  const started = Date.parse(thread?.run_started_at ?? "");
  return !(Number.isFinite(started) && started >= requested);
}
