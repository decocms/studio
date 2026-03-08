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
        threadId: command.threadId,
        orgId: command.orgId,
        userId: command.userId,
        abortController: command.abortController,
      };

      if (state?.status.tag === "running") {
        const aborted: RunEvent = {
          type: "PREVIOUS_RUN_ABORTED",
          threadId: command.threadId,
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
        threadId: command.threadId,
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
            threadId: command.threadId,
            orgId: state.orgId,
            stepCount,
          },
        ];
      }

      if (command.threadStatus === "requires_action") {
        return [
          {
            type: "RUN_REQUIRES_ACTION",
            threadId: command.threadId,
            orgId: state.orgId,
            stepCount,
          },
        ];
      }

      // threadStatus === "failed"
      return [
        {
          type: "RUN_FAILED",
          threadId: command.threadId,
          orgId: state.orgId,
          reason: "error",
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
          threadId: command.threadId,
          orgId: state.orgId,
          reason: "cancelled",
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
            threadId: command.threadId,
            orgId: state?.orgId ?? command.orgId,
            reason: command.reason,
          },
        ];
      }

      if (state?.status.tag !== "running") {
        return [];
      }

      return [
        {
          type: "RUN_FAILED",
          threadId: command.threadId,
          orgId: state.orgId,
          reason: command.reason,
        },
      ];
    }
  }
}
