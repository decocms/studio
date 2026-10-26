import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const SETTLED = new Set(["completed", "failed", "killed"]);

/**
 * Background tasks (Bash `run_in_background`, async subagents) still running.
 * The CLI starts a turn on its own when one settles, so a run with any left is
 * not finished at its turn's `result`.
 */
export class BackgroundTasks {
  private readonly running = new Set<string>();

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    switch (message.subtype) {
      case "task_started":
        if (message.is_backgrounded && !message.ambient) {
          this.running.add(message.task_id);
        }
        return;
      case "task_updated": {
        const { patch } = message;
        if (patch.status && SETTLED.has(patch.status)) {
          this.running.delete(message.task_id);
        } else if (patch.is_backgrounded) {
          this.running.add(message.task_id);
        }
        return;
      }
      case "task_notification":
        this.running.delete(message.task_id);
        return;
    }
  }

  get size(): number {
    return this.running.size;
  }
}
