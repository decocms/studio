import type { RunCommand, RunEvent, RunState } from "./run-state.ts";

/**
 * Pure decider: maps (command, current state) → events to apply.
 * No async, no I/O, no side effects. Returns [] when the command is invalid
 * for the current state (idempotent guard).
 */
export function decide(
  command: RunCommand,
  state: RunState | undefined,
): RunEvent[] {
  switch (command.type) {
    case "START": {
      const started: RunEvent = {
        type: "RUN_STARTED",
        taskId: command.taskId,
        orgId: command.orgId,
        userId: command.userId,
        abortController: command.abortController,
        runConfig: command.runConfig,
        podId: command.podId,
        messageId: command.messageId,
      };

      if (state?.status.tag === "running") {
        const aborted: RunEvent = {
          type: "PREVIOUS_RUN_ABORTED",
          taskId: command.taskId,
          orgId: state.orgId,
        };
        return [aborted, started];
      }

      return [started];
    }

    case "STEP_DONE": {
      if (state?.status.tag !== "running") {
        return [];
      }

      const completed: RunEvent = {
        type: "STEP_COMPLETED",
        taskId: command.taskId,
        orgId: state.orgId,
        stepCount: state.status.stepCount + 1,
      };

      return [completed];
    }

    case "FINISH": {
      if (state == null || state.status.tag !== "running") {
        return [];
      }

      const { stepCount } = state.status;

      if (command.threadStatus === "completed") {
        return [
          {
            type: "RUN_COMPLETED",
            taskId: command.taskId,
            orgId: state.orgId,
            stepCount,
          },
        ];
      }

      if (command.threadStatus === "requires_action") {
        return [
          {
            type: "RUN_REQUIRES_ACTION",
            taskId: command.taskId,
            orgId: state.orgId,
            stepCount,
          },
        ];
      }

      // threadStatus === "failed"
      return [
        {
          type: "RUN_FAILED",
          taskId: command.taskId,
          orgId: state.orgId,
          reason: "error",
          errorText: command.errorText ?? null,
        },
      ];
    }

    case "CANCEL": {
      if (state?.status.tag !== "running") {
        return [];
      }

      return [
        {
          type: "RUN_FAILED",
          taskId: command.taskId,
          orgId: state.orgId,
          reason: "cancelled",
        },
      ];
    }

    case "RESUME": {
      // Idempotent: if already running locally, no-op
      if (state?.status.tag === "running") return [];
      // Unlike START, does NOT abort an existing run
      return [
        {
          type: "RUN_RESUMED" as const,
          taskId: command.taskId,
          orgId: command.orgId,
          userId: command.userId,
          abortController: command.abortController,
          podId: command.podId,
        },
      ];
    }

    case "FORCE_FAIL": {
      if (command.reason === "ghost") {
        // The server restarted — no in-memory state. orgId is guaranteed on
        // the command by the discriminated union; fall back to state when
        // the run happens to still be live (e.g. race on restart).
        return [
          {
            type: "RUN_FAILED",
            taskId: command.taskId,
            orgId: state?.orgId ?? command.orgId,
            reason: command.reason,
            // Carry the cancel-time fence so the reactor force-fails only the
            // turn this cancel targeted, not a follow-up that started meanwhile.
            expectedFenceToken: command.expectedFenceToken ?? null,
          },
        ];
      }

      if (state?.status.tag !== "running") {
        return [];
      }

      return [
        {
          type: "RUN_FAILED",
          taskId: command.taskId,
          orgId: state.orgId,
          reason: command.reason,
        },
      ];
    }
  }
}
