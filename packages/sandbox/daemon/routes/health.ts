import { jsonResponse } from "./body-parser";

export interface HealthDeps {
  config: { daemonBootId: string };
  getReady: () => boolean;
  getOrchestrator: () => { running: boolean; pending: number };
  getConfigured: () => boolean;
}

export function makeHealthHandler(deps: HealthDeps): () => Response {
  return () => {
    const orch = deps.getOrchestrator();
    return jsonResponse({
      ready: deps.getReady(),
      bootId: deps.config.daemonBootId,
      configured: deps.getConfigured(),
      orchestrator: orch,
      // Legacy shape — daemon-client polls /health and validates this exists.
      // Orchestrator queue empty → setup is done.
      setup: { running: orch.running, done: !orch.running },
    });
  };
}
