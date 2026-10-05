/**
 * The org's "Jira" agent: the issue tools, usable from a chat.
 *
 * The integration's own tools (`JIRA_ISSUE_*`, `JIRA_COMMENT_ADD`, ...) were
 * written for the runs it starts, but they sit on `/mcp/self` like every other
 * management tool and work outside a run too (`resolveRunIssue`). This agent
 * selects them, plus `JIRA_RUN_START`, so a person can read and move the board
 * and start runs from a chat, through the same credential the automations use:
 * no second Jira login.
 *
 * It exists only while the integration is configured and enabled.
 * `syncJiraChatAgent` creates or refreshes it, or removes it, and is called on
 * every integration write and once per org at startup. Removing a virtual MCP
 * also removes its threads (`VirtualMCPStorage.delete`), so disconnecting Jira
 * drops this agent's chats with it.
 */

import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import type { ToolName } from "@decocms/shared/tools/registry-metadata";
import { getDb } from "@/database";
import { VirtualMCPStorage } from "@/storage/virtual";

const JIRA_CHAT_AGENT_PREFIX = "studio-jira_";

export function jiraChatAgentId(organizationId: string): string {
  return `${JIRA_CHAT_AGENT_PREFIX}${organizationId}`;
}

export const JIRA_CHAT_AGENT_TOOLS: readonly ToolName[] = [
  "JIRA_ISSUE_SEARCH",
  "JIRA_ISSUE_GET",
  "JIRA_COMMENT_ADD",
  "JIRA_ISSUE_TRANSITION",
  "JIRA_REMOTE_LINK_ADD",
  "JIRA_ISSUE_CREATE",
  "JIRA_ATTACHMENT_DOWNLOAD",
  "JIRA_BOARD_COLUMNS_LIST",
  "JIRA_AUTOMATION_LIST",
  "JIRA_RUN_START",
];

const INSTRUCTIONS = `<role>
You operate the organization's Jira board through Studio's Jira integration:
read and search issues, comment, move cards, add links, create issues, and
start agent runs on issues.
</role>

<capabilities>
- Search the connected board with JIRA_ISSUE_SEARCH (JQL) and read an issue
  with JIRA_ISSUE_GET. Pass \`issueKey\` on every issue tool.
- Comment (JIRA_COMMENT_ADD), move a card (JIRA_ISSUE_TRANSITION, by status
  name; JIRA_BOARD_COLUMNS_LIST lists them), attach a link
  (JIRA_REMOTE_LINK_ADD), and create an issue in the board's project
  (JIRA_ISSUE_CREATE).
- Start a run on one or more issues with JIRA_RUN_START. A run works in a
  sandbox with the repository and can implement, review, merge, release or
  validate. Use \`together: true\` to give several issues to a single run.
</capabilities>

<starting_runs>
A run follows the prompt you give it. For the standard flows, tell it which
skill to follow; the skills are files in the run's sandbox:
- implement an issue: /mnt/skills/public/jira-execute/SKILL.md
- review: /mnt/skills/public/jira-review/SKILL.md
- QA gate: /mnt/skills/public/jira-qa-gate/SKILL.md
- assemble or ship a release: /mnt/skills/public/jira-release/SKILL.md
- merge cards outside a release: /mnt/skills/public/jira-merge/SKILL.md
- validate in production: /mnt/skills/public/jira-validate-production/SKILL.md
Write the prompt as: what to do and on which issues, anything the person told
you that the issues do not say, then "Read <skill path> first and follow it."
If the org keeps its own Jira skill, tell the run to read that one too.
</starting_runs>

<constraints>
- Every write lands on the real board under the integration's account. Before
  moving cards, merging or starting runs on several issues, state the plan in
  one short message and ask the person to confirm.
- Only issues on the connected board are reachable.
- Do not claim a run's result before it finishes; JIRA_RUN_START only starts it.
</constraints>`;

/**
 * Create, refresh or remove the org's Jira agent to match the integration.
 * Idempotent: safe to call on every write and at every startup.
 */
export async function syncJiraChatAgent(
  virtualMcps: VirtualMCPStorage,
  input: { organizationId: string; userId: string; enabled: boolean },
): Promise<void> {
  const id = jiraChatAgentId(input.organizationId);
  const existing = await virtualMcps.findById(id, input.organizationId);

  if (!input.enabled) {
    if (existing) await virtualMcps.delete(id);
    return;
  }

  const connections = [
    {
      connection_id: WellKnownOrgMCPId.SELF(input.organizationId),
      selected_tools: [...JIRA_CHAT_AGENT_TOOLS],
      selected_resources: null,
      selected_prompts: [],
    },
  ];

  const refresh = (current: { metadata?: unknown }) =>
    virtualMcps.update(id, input.userId, {
      metadata: {
        ...((current.metadata as Record<string, unknown>) ?? {}),
        instructions: INSTRUCTIONS,
      },
      connections,
    });

  if (existing) {
    await refresh(existing);
    return;
  }

  try {
    await virtualMcps.create(
      input.organizationId,
      input.userId,
      {
        title: "Jira",
        description:
          "Read and move the Jira board and start agent runs on its issues, through the org's Jira integration.",
        icon: "icon://Ticket01?color=blue",
        status: "active",
        pinned: false,
        metadata: { instructions: INSTRUCTIONS },
        connections,
      },
      { id },
    );
  } catch (err) {
    // Every replica runs the startup backfill: another one may have created
    // it between the read above and this write.
    const raced = await virtualMcps.findById(id, input.organizationId);
    if (!raced) throw err;
    await refresh(raced);
  }
}

/**
 * Startup pass over the orgs that have an integration: the agent where it is
 * enabled (with the current definition), none where it is disabled. Removal on
 * disconnect happens in `JIRA_INTEGRATION_DELETE`. Idempotent; a handful of
 * orgs, so no workflow.
 */
export async function backfillJiraChatAgents(): Promise<void> {
  const { db } = getDb();
  const virtualMcps = new VirtualMCPStorage(db);
  const integrations = await db
    .selectFrom("org_jira_integrations")
    .select(["organization_id", "created_by", "enabled"])
    .execute();
  for (const row of integrations) {
    await syncJiraChatAgent(virtualMcps, {
      organizationId: row.organization_id,
      userId: row.created_by,
      enabled: row.enabled,
    }).catch((err) => {
      console.error(
        `[jira-chat-agent] backfill failed for ${row.organization_id}:`,
        err,
      );
    });
  }
}
