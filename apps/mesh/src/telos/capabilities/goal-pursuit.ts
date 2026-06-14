import { defineCapability } from "../durable/capability";
import {
  ensureTelosPursuitSchedule,
  runPursuitCycle,
} from "../durable/pursuit";

// After a goal is installed, pursue it once immediately (responsiveness), then —
// unless it's already reached — arm the recurring loop so the Eudaimon re-observes
// and re-acts each cycle until the gap closes. The loop self-rests by not re-arming
// once reached; a safety-net heartbeat revives any loop whose chain died. OAOO on
// (org, version) dedupes re-fires of the same goal.
defineCapability({
  name: "goal-pursuit",
  version: "v3",
  on: "goal.installed",
  key: (event) => `${event.organizationId}:${event.version}`,
  run: async (event, { step }) => {
    const { reached } = await step("pursue", () =>
      runPursuitCycle(event.organizationId),
    );
    // ensure arms the debounced loop — it starts a workflow, so it runs in the
    // capability's workflow body, never inside a step.
    if (!reached) await ensureTelosPursuitSchedule(event.organizationId);
  },
});
