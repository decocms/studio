import { defineCapability } from "../durable/capability";
import {
  deleteTelosPursuitSchedule,
  ensureTelosPursuitSchedule,
  runPursuitCycle,
} from "../durable/pursuit";

// After a goal is installed, pursue it once immediately (responsiveness), then
// keep a recurring schedule so the Eudaimon re-observes and re-acts each cycle
// until the gap closes — the continuous striver of the telos model, not a
// one-shot. When the cycle reports the goal reached, the agent rests: the
// schedule is removed. OAOO on (org, version) dedupes re-fires of the same goal.
defineCapability({
  name: "goal-pursuit",
  version: "v2",
  on: "goal.installed",
  key: (event) => `${event.organizationId}:${event.version}`,
  run: async (event, { step }) => {
    const { reached } = await step("pursue", () =>
      runPursuitCycle(event.organizationId),
    );
    if (reached) {
      await step("rest", () =>
        deleteTelosPursuitSchedule(event.organizationId),
      );
    } else {
      await step("schedule", () =>
        ensureTelosPursuitSchedule(event.organizationId),
      );
    }
  },
});
