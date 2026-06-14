/**
 * The telos (purpose) a decopilot agent carries.
 *
 * The decopilot agent IS the Eudaimon — it already owns the loop, the brain
 * (the LLM), and the hands (the harness toolset). So telos here is NOT a second
 * agent: it's only the *purpose* the agent carries, expressed as a `Telos<T>`
 * with up to three faculties — charter (always), guard, measure.
 *
 * The same mechanism serves any agent the user creates; the purpose differs per
 * agent (its `AgentGoal`, read from the ledger keyed by the agent id), the
 * charter rendering is shared.
 */

import type { Guard, Telos } from "@decocms/telos";
import { type AgentGoal, latestAgentGoal } from "@/telos/agents";

export const decopilotTelos: Telos<AgentGoal> = {
  charter: (goal) =>
    `# Your telos (the purpose you exist to serve)\n\n${goal.statement}\n\n` +
    `Everything you do must serve this purpose. Do not redefine it; when it is ` +
    `met, say so plainly and stop rather than inventing further work.`,

  // guard / measure are extension points: a purpose that wants its tool calls
  // screened supplies a `guard` (a daimonion, applied via guardTools), and one
  // with an observable world supplies `measure`. The default decopilot purpose
  // is charter-only — we don't fabricate veto policy or KPIs it doesn't have.
};

// Resolve an agent's carried telos for one run: its installed purpose rendered
// to a charter (+ any guard). Null when the agent has no purpose installed.
export async function resolveAgentTelos(
  agentId: string,
): Promise<{ charter: string; guard?: Guard } | null> {
  const goal = await latestAgentGoal(agentId);
  if (!goal) return null;
  return { charter: decopilotTelos.charter(goal), guard: decopilotTelos.guard };
}
