/**
 * Registers Demo Mode's inline chat-part renderers with the core chat renderer.
 * Imported for its side effect by DemoProviders, so these only activate inside
 * the demo (the registry is empty in the normal app).
 */
import { registerPartRenderer } from "@/web/components/chat/message/parts/extra-part-renderers";
import { WorkPlanCard, PRCard, DailyDigestCard } from "./work-plan";
import type { DigestState, PlanState, PRState } from "./director-stores";

registerPartRenderer("tool-work_plan", (part) => (
  <WorkPlanCard plan={part.output as PlanState} />
));

registerPartRenderer("tool-pull_request", (part) => (
  <PRCard pr={part.output as PRState} />
));

registerPartRenderer("tool-daily_digest", (part) => (
  <DailyDigestCard digest={part.output as DigestState} />
));
