/** An automation detail is valid inside an agent route only when both durable
 * identities agree. This prevents a stale or crafted URL from coupling one
 * agent's workspace/runtime to another agent's automation. */
export function automationMatchesRouteAgent(
  automationAgentId: string,
  routeAgentId: string,
): boolean {
  return automationAgentId === routeAgentId;
}
