import type { SetupOrchestrator, Step } from "../setup/orchestrator";
import { jsonResponse } from "./body-parser";

export interface SetupRouteDeps {
  orchestrator: SetupOrchestrator;
}

/**
 * Retry endpoints. Each one resumes the pipeline from a named step:
 *   - clone   → re-acquire source, then install + start
 *   - install → reinstall deps, then start
 *   - start   → restart the dev script
 *
 * Idempotent: enqueueing the same step while one is in flight is a no-op
 * (the orchestrator coalesces). Higher-rank steps subsume lower-rank
 * pending work.
 */
export function makeSetupHandler(
  step: Step,
  deps: SetupRouteDeps,
): () => Response {
  return () => {
    deps.orchestrator.resumeFrom(step);
    return jsonResponse({ enqueued: step });
  };
}
