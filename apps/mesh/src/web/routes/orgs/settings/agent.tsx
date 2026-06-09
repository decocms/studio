import { AgentSettings } from "@/web/views/deco-redesign/agent-settings";

/**
 * The agent's settings — one page that organizes the editable "outside"
 * (personalization: guidance, your skills, connections) with the managed
 * "inside" (definition: prompt, memory, files, automations).
 */
export default function AgentSettingsRoute() {
  return <AgentSettings />;
}
