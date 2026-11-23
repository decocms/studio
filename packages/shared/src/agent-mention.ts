/**
 * What an `@agent` mention in the composer adds to the message it rides on.
 *
 * Context only, and the same for every harness: the text is stored on
 * automations and the server picks the harness at dispatch, so it can name no
 * tool. Decopilot's `subtask` description says what a mention means there; a
 * sandbox-hosted run has no tool that delegates to another agent.
 */
export const AGENT_MENTION_LABEL = "MENTIONED AGENT";

export function agentMentionContext(agent: {
  title: string;
  agentId: string;
}): string {
  return (
    `[${AGENT_MENTION_LABEL}: ${agent.title} (agent_id: ${agent.agentId})]\n` +
    "The user mentioned this agent in their message."
  );
}
