import { defineCapability } from "../durable/capability";
import {
  ensureTelosPursuitSchedule,
  runPursuitCycle,
} from "../durable/pursuit";

// After a goal is installed, pursue it once immediately (responsiveness), then arm
// the recurring loop so the Eudaimon re-observes and re-acts each cycle. The Goal
// is enduring (never satisfied), so the loop keeps striving — a safety-net
// heartbeat revives any loop whose chain died. OAOO on (org, version) dedupes
// re-fires of the same goal. ensureTelosPursuitSchedule starts a workflow, so it
// runs in the capability's workflow body, never inside a step.
defineCapability({
  name: "goal-pursuit",
  version: "v3",
  on: "goal.installed",
  key: (event) => `${event.organizationId}:${event.version}`,
  run: async (event, { step }) => {
    await step("pursue", () => runPursuitCycle(event.organizationId));
    await ensureTelosPursuitSchedule(event.organizationId);
  },
});
