import type { GoalLedger } from "@decocms/telos";
import {
  createPostgresGoalLedger,
  type TelosTables,
} from "@decocms/telos/postgres";
import type { Kysely } from "kysely";
import { requireTelosRuntime } from "./durable/runtime";

// The purpose carried by an agent (a Virtual MCP). Minimal by design: the
// statement is what the agent is FOR, rendered into its system prompt as a
// charter. Stored in the same `telos.goals` ledger as onboarding goals, but
// under an `agent:<id>` tenant so the two namespaces never collide.
export interface AgentGoal {
  statement: string;
}

// Agent purposes share the goal ledger with onboarding (target is opaque jsonb);
// the tenant prefix keeps agent ids from colliding with org ids.
const agentTenant = (agentId: string): string => `agent:${agentId}`;

const agentGoalLedger = (): GoalLedger<AgentGoal> => {
  const db = requireTelosRuntime().db as unknown as Kysely<TelosTables>;
  return createPostgresGoalLedger<AgentGoal>(db);
};

// Authority install: set (or raise, via succession) an agent's purpose. Append-
// only — re-installing appends a new version, it never mutates the old one.
export async function installAgentGoal(
  agentId: string,
  goal: AgentGoal,
): Promise<void> {
  await agentGoalLedger().install(agentTenant(agentId), goal, "authority");
}

// The agent's current purpose, or null if none was ever installed (older agents
// degrade gracefully — no telos, no charter block, no guard).
export async function latestAgentGoal(
  agentId: string,
): Promise<AgentGoal | null> {
  try {
    return (await agentGoalLedger().latest(agentTenant(agentId))).target;
  } catch {
    return null;
  }
}
