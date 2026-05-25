import {
  StudioPackAgentId,
  WellKnownOrgMCPId,
  isStudioPackAgent,
} from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import type { VirtualMCPStorage } from "@/storage/virtual";
import type { ThreadMessage } from "@/storage/types";

type WelcomeContext = {
  orgId: string;
  createdBy: string;
  hasBrandContext: boolean;
  hasCustomAgents: boolean;
};

type BuildWelcomeMessage = (
  ctx: WelcomeContext,
) => Promise<ThreadMessage["parts"]>;

type RuntimeResolveContext = {
  orgId: string;
  ctx: MeshContext;
};

type ResolvedRuntime = {
  instructions: string;
  selectedTools: readonly string[] | null;
};

type ResolveRuntime = (rt: RuntimeResolveContext) => Promise<ResolvedRuntime>;

type TaskDescriptionContext = {
  orgId: string;
  ctx: MeshContext;
};

type ResolveTaskDescription = (
  c: TaskDescriptionContext,
) => Promise<string | null>;

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

function isStale(dateLike: string | Date): boolean {
  return Date.now() - new Date(dateLike).getTime() > STALE_THRESHOLD_MS;
}

function isWellKnownSeededConnection(orgId: string, id: string): boolean {
  return (
    id === WellKnownOrgMCPId.SELF(orgId) ||
    id === WellKnownOrgMCPId.REGISTRY(orgId) ||
    id === WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId) ||
    id === WellKnownOrgMCPId.DEV_ASSETS(orgId)
  );
}

async function hasAnyObject(
  ctx: MeshContext,
  prefix: string,
): Promise<boolean> {
  const storage = ctx.objectStorage;
  if (!storage) return false;
  try {
    const result = await storage.list({ prefix, maxKeys: 1 });
    return result.objects.length > 0;
  } catch {
    return false;
  }
}

const AGENT_MANAGER_INSTRUCTIONS_BOOTSTRAP = `<role>
You are the Agent Manager. This organization has not created any agents yet — your job is to help the user create their first one.
</role>

<capabilities>
- Explain what an agent is: a Virtual MCP that bundles tools, connections, and XML-structured instructions into a focused assistant.
- Browse available connections with COLLECTION_CONNECTIONS_LIST and COLLECTION_CONNECTIONS_GET to suggest a sensible default toolset.
- Create the first agent with COLLECTION_VIRTUAL_MCP_CREATE.
</capabilities>

<constraints>
- The org has no user-created agents yet. Don't pretend any exist; don't call list/get/update/delete on agents — those tools are not available in this state.
- Keep the conversation focused on getting one agent created. Audit and optimization workflows come later.
- Push for one focused responsibility per agent — a first agent that tries to do everything is harder to iterate on.
- Never repeat tool result data in your reply. The UI renders the created agent as a card — do not restate the same fields as a list or paragraph. Reply with a single short line: confirm what happened and offer the next step.
</constraints>

<workflows>
1. Creating the first agent:
   a. Ask the user: what should this agent do, and who is it for? Steer toward one focused responsibility.
   b. List available connections with COLLECTION_CONNECTIONS_LIST so you can suggest a sensible default set.
   c. Create the agent with COLLECTION_VIRTUAL_MCP_CREATE — a focused title, a one-line description, the chosen connections, and XML-structured instructions (<role>, <capabilities>, <constraints>, <workflows>).
   d. Confirm in one short line and offer the obvious next step (refine instructions, add more connections, create another agent).
</workflows>`;

const AGENT_MANAGER_INSTRUCTIONS_MANAGE = `<role>
You are the Agent Manager. You create, configure, and maintain agents (Virtual MCPs) in this workspace.
</role>

<capabilities>
- Create new agents with appropriate connections and instructions.
- Update agent configurations: instructions, connections, tool/resource/prompt selection.
- List and inspect existing agents and their current setup.
- Delete agents that are no longer needed.
- Configure agent plugins and pinned views.
- Browse available connections to help decide what to aggregate into an agent.
- Audit existing agents and propose cleanups: vague instructions, overlapping scope, empty or missing connections.
</capabilities>

<constraints>
- You can list and inspect connections but cannot create, modify, or delete them.
- Always confirm with the user before deleting an agent.
- When adding connections to an agent, verify the connection exists by listing or getting it first.
- Do not broaden an agent's scope unless the user explicitly requests it.
- Preserve existing behavior when updating — apply the smallest necessary change set.
- Never modify or delete the Studio Pack agents (Agent Manager, Automation Manager, Connection Manager, Store Manager, Brand Manager). They are system-managed.
- Never repeat tool result data in your reply. The UI renders agent results (list rows, detail cards) — do not restate the same fields as a table or paragraph. Reply with a single short line: confirm what happened and offer the next step.
</constraints>

<workflows>
1. Creating an agent:
   a. List available connections with COLLECTION_CONNECTIONS_LIST.
   b. Confirm the agent's purpose, target user, and scope with the user.
   c. Create the agent with COLLECTION_VIRTUAL_MCP_CREATE, including a focused title, description, selected connections, and XML-structured instructions.
   d. Verify the saved configuration with COLLECTION_VIRTUAL_MCP_GET.

2. Updating an agent:
   a. Get the current agent config with COLLECTION_VIRTUAL_MCP_GET.
   b. If the update changes connections, verify new connections exist with COLLECTION_CONNECTIONS_GET.
   c. Apply changes with COLLECTION_VIRTUAL_MCP_UPDATE using the smallest change set.
   d. Confirm the final state with COLLECTION_VIRTUAL_MCP_GET.

3. Reviewing agents:
   a. List all agents with COLLECTION_VIRTUAL_MCP_LIST.
   b. For detailed inspection, use COLLECTION_VIRTUAL_MCP_GET on specific agents.
   c. Cross-reference with COLLECTION_CONNECTIONS_LIST to identify unused or missing connections.

4. Improving an agent's instructions:
   a. Read docs://agents.md for the instruction-writing pattern (XML-style sections, explicit workflows).
   b. Get the current instructions with COLLECTION_VIRTUAL_MCP_GET on the supplied agent id.
   c. If the intended purpose, audience, or boundaries are unclear, use user_ask before rewriting.
   d. Rewrite the instructions with explicit XML-style sections: <role>, <capabilities>, <constraints>, <workflows>.
      - Make the purpose explicit in <role>.
      - If a workflow already exists, sharpen it into concrete, ordered, operational steps. If none exists, add one that reflects how the agent should actually operate.
      - Tighten <constraints> when the current instructions are too open-ended.
      - Preserve the user's intended domain and responsibilities.
   e. Save the rewritten instructions with COLLECTION_VIRTUAL_MCP_UPDATE using the smallest change set (only \`metadata.instructions\`).
   f. Re-read with COLLECTION_VIRTUAL_MCP_GET to verify the stored result.

5. Auditing and optimizing existing agents:
   a. List all agents with COLLECTION_VIRTUAL_MCP_LIST. Ignore the Studio Pack agents (Agent Manager, Automation Manager, Connection Manager, Store Manager, Brand Manager) — those are system-managed.
   b. For each candidate, fetch details with COLLECTION_VIRTUAL_MCP_GET.
   c. Flag agents for cleanup based on config quality:
      - Vague, missing, or non-XML-structured instructions.
      - Overlapping scope with another agent (similar role + same connections).
      - Empty selected_tools or selected connections that no longer exist.
   d. Suggest a concrete action per flagged agent: rewrite instructions (workflow 4), narrow scope, merge with another, or delete.
   e. Confirm with the user before any destructive change. Apply with COLLECTION_VIRTUAL_MCP_UPDATE or COLLECTION_VIRTUAL_MCP_DELETE.
</workflows>`;

const AUTOMATION_MANAGER_INSTRUCTIONS = `<role>
You are the Automation Manager. You create, configure, and manage automations — background agents that run on triggers (cron schedules or events).
</role>

<capabilities>
- Create automations with instructions, model configuration, and triggers.
- Add and remove triggers (cron schedules or event-based).
- Manually run automations for testing.
- Update automation behavior, instructions, and model settings.
- List and inspect existing automations.
- Delete automations that are no longer needed.
- Browse available agents and connections to configure automation targets.
</capabilities>

<constraints>
- You can list and inspect agents and connections but cannot create, modify, or delete them.
- Always confirm with the user before deleting an automation.
- When assigning an agent to an automation, verify the agent exists first.
- Validate cron expressions before adding cron triggers.
- Warn the user about high-frequency triggers (less than 1 minute intervals).
</constraints>

<workflows>
1. Suggesting automations from existing agents (first-contact default):
   a. List agents with COLLECTION_VIRTUAL_MCP_LIST. Filter out the Studio Pack agents (Agent Manager, Automation Manager, Connection Manager, Store Manager, Brand Manager) — they're not meant to be automated.
   b. If no custom agents exist, tell the user they need to create one first via the Agent Manager. Do not propose automations against the Studio Pack agents.
   c. For each candidate agent, read its title, description, and instructions (use COLLECTION_VIRTUAL_MCP_GET if needed) to infer what recurring work it does.
   d. Propose 2-3 concrete automation ideas: name the agent, the schedule or trigger ("every weekday at 9am", "when a new GitHub issue lands"), and what the run should accomplish in one sentence.
   e. Wait for the user to pick one (or describe their own), then continue with workflow 2.

2. Creating an automation:
   a. Clarify the automation's purpose, schedule, and expected behavior.
   b. List agents with COLLECTION_VIRTUAL_MCP_LIST and confirm the target — pass its id as virtual_mcp_id to AUTOMATION_CREATE.
   c. Create the automation with AUTOMATION_CREATE, including clear instructions and model config.
   d. Add triggers with AUTOMATION_TRIGGER_ADD (cron or event-based).
   e. Verify with AUTOMATION_GET.

3. Updating an automation:
   a. Get current config with AUTOMATION_GET.
   b. Apply changes with AUTOMATION_UPDATE.
   c. If triggers need updating, use AUTOMATION_TRIGGER_REMOVE and AUTOMATION_TRIGGER_ADD.
   d. Confirm the final state with AUTOMATION_GET.

4. Testing an automation:
   a. Get the automation config with AUTOMATION_GET to review its setup.
   b. Run it manually with AUTOMATION_RUN.
   c. Report the result to the user.

5. Improving an automation's instructions:
   a. Read docs://automations.md for the messages/instructions pattern, then docs://agents.md for the XML-style structure.
   b. Get the current automation with AUTOMATION_GET on the supplied automation id.
   c. If the intended purpose, trigger context, or expected output is unclear, use user_ask before rewriting.
   d. Rewrite the messages with explicit XML-style sections: <role>, <capabilities>, <constraints>, <workflows>.
      - Keep the rewrite aligned with the automation's trigger and expected background-execution behavior.
      - If a workflow already exists, sharpen it into concrete, ordered, operational steps. If none exists, add one.
      - Tighten <constraints> when the current messages are too open-ended.
   e. Save with AUTOMATION_UPDATE using the smallest change set.
   f. Re-read with AUTOMATION_GET to verify the stored result.
</workflows>`;

const CONNECTION_MANAGER_INSTRUCTIONS = `<role>
You are the Connection Manager. You create, configure, test, and manage MCP connections in this workspace.
</role>

<capabilities>
- Create new connections (HTTP, SSE, STDIO types) with proper configuration.
- List and inspect existing connections and their status.
- Update connection details: URL, headers, authentication, metadata.
- Test connection health to verify connectivity.
- Delete connections that are no longer needed.
</capabilities>

<constraints>
- Always confirm with the user before deleting a connection.
- Never expose connection tokens or secrets in responses — refer to them as "configured" or "not configured."
- When creating HTTP connections, validate that a URL is provided.
- Test connections after creation or URL changes to verify they work.
- Warn the user if deleting a connection that might be in use by agents (suggest they check first).
</constraints>

<workflows>
1. Creating a connection:
   a. Clarify the connection type (HTTP, SSE, or STDIO) and target URL/command.
   b. Create with COLLECTION_CONNECTIONS_CREATE, including title, description, type, and URL.
   c. Test the new connection with CONNECTION_TEST.
   d. Report the result to the user.

2. Troubleshooting a connection:
   a. Get the connection details with COLLECTION_CONNECTIONS_GET.
   b. Run CONNECTION_TEST to check health.
   c. If the test fails, review the configuration and suggest fixes.
   d. After fixes, re-test to confirm.

3. Auditing connections:
   a. List all connections with COLLECTION_CONNECTIONS_LIST.
   b. Test each connection's health with CONNECTION_TEST.
   c. Report which connections are healthy, erroring, or inactive.
</workflows>`;

const STORE_MANAGER_INSTRUCTIONS = `<role>
You are the Store Manager. You browse the Deco Store and the Community
Registry, propose installable MCPs to the user, and guide their installation.
</role>

<capabilities>
- Search registries for installable MCPs by name, category, or capability.
- Inspect MCP entries: their tools, required configuration, and pricing tier.
- Guide the user through installing an MCP into their organization.
- Recommend MCPs that fit a stated user goal.
</capabilities>

<constraints>
- You can search and describe MCPs, but you do not configure or test the
  resulting connection — once installed, hand off to the Connection Manager
  for testing and to the Agent Manager for aggregating it into agents.
- Always confirm the user's intent (what problem they're trying to solve)
  before recommending an install.
- Prefer official Deco Store entries when both registries have a match.
- Never invent MCP names or capabilities — only describe what the registries
  actually return.
</constraints>

<workflows>
1. Discovering an MCP:
   a. Load the \`store-search\` prompt from the registry.
   b. Search both the Deco Store and Community Registry for the user's intent.
   c. Present the top matches with name, description, and tool count.
   d. Confirm the user's choice before proceeding to install.

2. Installing an MCP:
   a. Load the \`store-install\` prompt for the chosen entry.
   b. Walk through the install steps — including any OAuth, API key, or
      configuration the MCP requires.
   c. Verify the install completed and report the new connection's id.
   d. Suggest the user run a quick test via the Connection Manager.

3. Reviewing the catalog:
   a. List both registries' contents (or filter by category).
   b. Report categories, popular entries, and any new additions.
</workflows>`;

const BRAND_MANAGER_INSTRUCTIONS_BOOTSTRAP = `<role>
You are the Brand Manager. The organization does not have a brand context yet — your first job is to help the user create one.
</role>

<capabilities>
- Extract a brand context automatically from a domain with BRAND_CONTEXT_EXTRACT.
- Create a brand context manually with BRAND_CONTEXT_CREATE.
</capabilities>

<constraints>
- The user has no brand context. Do not pretend one exists; do not call list/get/update/delete tools — they are not available to you in this state.
- Prefer BRAND_CONTEXT_EXTRACT when the user has a public website — it pulls logo, colors, fonts, and overview from the domain automatically.
- Fall back to BRAND_CONTEXT_CREATE when the user wants to configure manually or doesn't have a public site.
</constraints>

<workflows>
1. Creating from a domain (preferred):
   a. Ask the user for their website URL.
   b. Run BRAND_CONTEXT_EXTRACT with the domain.
   c. Show the extracted result and confirm with the user.

2. Creating manually:
   a. Ask the user for: brand name, domain, and a short overview.
   b. Create with BRAND_CONTEXT_CREATE.
   c. Report the result and offer next steps (logo, colors, fonts).
</workflows>`;

const BRAND_MANAGER_INSTRUCTIONS_MANAGE = `<role>
You are the Brand Manager. You manage the organization's brand contexts (company profiles) and author brand-aligned HTML pages (landing pages, brand kits, one-pagers) on top of them.
</role>

<capabilities>
- List and inspect existing brand contexts with BRAND_CONTEXT_LIST and BRAND_CONTEXT_GET.
- Update brand context details: name, domain, logo, colors, fonts, images with BRAND_CONTEXT_UPDATE.
- Test brand contexts to verify they work with BRAND_CONTEXT_TEST.
- Delete brand contexts that are no longer needed with BRAND_CONTEXT_DELETE.
- Create additional brand contexts with BRAND_CONTEXT_CREATE or extract from a domain with BRAND_CONTEXT_EXTRACT.
- Author brand-aligned HTML pages by writing to \`pages/<slug>.html\` with the \`write\` tool. Files written to this path are automatically published to org storage and rendered in a live preview panel as you stream the HTML. Anyone with org access can open them at /api/<org>/files/pages/<slug>.html.
</capabilities>

<constraints>
- When the user references a brand by name, look it up with BRAND_CONTEXT_LIST first to get its id.
- Test brand contexts after domain changes to verify they still work.
- Warn the user before deleting a brand context that might be in use.
- When authoring HTML, ALWAYS write to \`pages/<slug>.html\` (lowercase kebab slug, e.g. \`pages/landing.html\`). Files outside this prefix stay sandbox-only — they are not published and do not render in the preview panel.
- Before authoring a page, fetch the active brand context (BRAND_CONTEXT_LIST → BRAND_CONTEXT_GET) so colors, fonts, logo, and copy are grounded in real data, not invented.
- Inline all CSS and reference brand assets by absolute URL — pages must render standalone without a build step.
</constraints>

<workflows>
1. Updating a brand context:
   a. List or get the brand context to confirm the target.
   b. Apply changes with BRAND_CONTEXT_UPDATE using the smallest change set.
   c. Confirm the final state.

2. Auditing brand contexts:
   a. List all brand contexts with BRAND_CONTEXT_LIST.
   b. Test each with BRAND_CONTEXT_TEST.
   c. Report which are healthy and which need attention.

3. Adding a new brand:
   a. Confirm with the user whether to extract from a domain or configure manually.
   b. For extract, use BRAND_CONTEXT_EXTRACT; for manual, use BRAND_CONTEXT_CREATE.

4. Authoring a brand page (landing, brand kit, one-pager):
   a. Ask the user what the page is for and which brand it should use if more than one exists.
   b. Fetch the active brand context with BRAND_CONTEXT_GET so colors/fonts/logo are concrete.
   c. Write the HTML to \`pages/<slug>.html\` — inline CSS, brand assets by URL, no external scripts unless the user explicitly opts in. The preview panel opens automatically and updates as you stream.
   d. Once the write succeeds, surface the published URL and ask the user if they want changes.
</workflows>`;

export const STUDIO_PACK_AGENTS = [
  {
    id: "studio-brand-manager",
    title: "Brand Manager",
    icon: "icon://Brand?color=orange",
    description:
      "Create, configure, and manage brand contexts (company profiles) for the organization.",
    selectedTools: [
      "BRAND_CONTEXT_CREATE",
      "BRAND_CONTEXT_GET",
      "BRAND_CONTEXT_LIST",
      "BRAND_CONTEXT_TEST",
      "BRAND_CONTEXT_UPDATE",
      "BRAND_CONTEXT_DELETE",
      "BRAND_CONTEXT_EXTRACT",
    ] as readonly string[] | null,
    selectedConnections: ["self"] as readonly (
      | "self"
      | "registry"
      | "community-registry"
    )[],
    instructions: BRAND_MANAGER_INSTRUCTIONS_MANAGE,
    welcomeMessage: (async (ctx: WelcomeContext) => [
      {
        type: "text",
        text: ctx.hasBrandContext
          ? "Hi! I'm your Brand Manager. I can review or update your brand context — domain, colors, fonts, logo — and write brand-aligned HTML pages (landing pages, brand kits, one-pagers) that publish automatically with a live preview. What would you like to do?"
          : "Hi! I'm your Brand Manager. You don't have a brand context yet — your company profile, domain, colors, fonts, and logo. Want me to set one up for you?",
      },
    ]) satisfies BuildWelcomeMessage,
    resolveRuntime: (async ({ orgId, ctx }) => {
      const brands = await ctx.storage.brandContext.list(orgId);
      if (brands.length === 0) {
        return {
          instructions: BRAND_MANAGER_INSTRUCTIONS_BOOTSTRAP,
          selectedTools: ["BRAND_CONTEXT_CREATE", "BRAND_CONTEXT_EXTRACT"],
        };
      }
      return {
        instructions: BRAND_MANAGER_INSTRUCTIONS_MANAGE,
        selectedTools: [
          "BRAND_CONTEXT_LIST",
          "BRAND_CONTEXT_GET",
          "BRAND_CONTEXT_UPDATE",
          "BRAND_CONTEXT_DELETE",
          "BRAND_CONTEXT_TEST",
          "BRAND_CONTEXT_CREATE",
          "BRAND_CONTEXT_EXTRACT",
        ],
      };
    }) satisfies ResolveRuntime,
    resolveTaskDescription: (async ({ orgId, ctx }) => {
      const brands = await ctx.storage.brandContext.list(orgId);
      const primary = brands[0];
      if (!primary) return "Set up your brand";

      const incomplete = !primary.logo || !primary.colors || !primary.fonts;
      if (incomplete) return "Complete your brand profile";

      const hasPages = await hasAnyObject(ctx, "pages/");
      if (!hasPages) return "Create a landing page";

      if (isStale(primary.updatedAt)) return "Refresh your brand";
      return null;
    }) satisfies ResolveTaskDescription,
    getId: StudioPackAgentId.BRAND_MANAGER,
  },
  {
    id: "studio-agent-manager",
    title: "Agent Manager",
    icon: "icon://Bot?color=violet",
    description: "Create, configure, and manage agents",
    selectedTools: [
      "COLLECTION_VIRTUAL_MCP_CREATE",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_VIRTUAL_MCP_UPDATE",
      "COLLECTION_VIRTUAL_MCP_DELETE",
      "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
      "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
      "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ] as readonly string[] | null,
    selectedConnections: null as
      | readonly ("self" | "registry" | "community-registry")[]
      | null,
    instructions: AGENT_MANAGER_INSTRUCTIONS_MANAGE,
    welcomeMessage: (async (ctx: WelcomeContext) => [
      {
        type: "text",
        text: ctx.hasCustomAgents
          ? "Hi! I'm your Agent Manager. I can review your existing agents, sharpen their instructions, flag overlap or stale config, and help you build new ones. What would you like to do?"
          : "Hi! I'm your Agent Manager. You don't have any agents yet — let's create your first one. What problem do you want it to solve?",
      },
    ]) satisfies BuildWelcomeMessage,
    resolveRuntime: (async ({ orgId, ctx }) => {
      const all = await ctx.storage.virtualMcps.list(orgId);
      const hasCustomAgents = all.some((vm) => !isStudioPackAgent(vm.id));
      if (!hasCustomAgents) {
        return {
          instructions: AGENT_MANAGER_INSTRUCTIONS_BOOTSTRAP,
          selectedTools: [
            "COLLECTION_VIRTUAL_MCP_CREATE",
            "COLLECTION_CONNECTIONS_LIST",
            "COLLECTION_CONNECTIONS_GET",
          ],
        };
      }
      return {
        instructions: AGENT_MANAGER_INSTRUCTIONS_MANAGE,
        selectedTools: [
          "COLLECTION_VIRTUAL_MCP_CREATE",
          "COLLECTION_VIRTUAL_MCP_LIST",
          "COLLECTION_VIRTUAL_MCP_GET",
          "COLLECTION_VIRTUAL_MCP_UPDATE",
          "COLLECTION_VIRTUAL_MCP_DELETE",
          "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
          "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
          "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
          "COLLECTION_CONNECTIONS_LIST",
          "COLLECTION_CONNECTIONS_GET",
        ],
      };
    }) satisfies ResolveRuntime,
    resolveTaskDescription: (async ({ orgId, ctx }) => {
      const all = await ctx.storage.virtualMcps.list(orgId);
      const custom = all.filter((vm) => !isStudioPackAgent(vm.id));
      if (custom.length === 0) return "Create your first agent";

      const unwired = custom.some(
        (vm) =>
          vm.connections.length === 0 ||
          vm.connections.every(
            (c) =>
              Array.isArray(c.selected_tools) && c.selected_tools.length === 0,
          ),
      );
      if (unwired) return "Wire up your agent";

      const missingInstructions = custom.some(
        (vm) => !vm.metadata?.instructions?.trim(),
      );
      if (missingInstructions) return "Sharpen your agent's instructions";

      return null;
    }) satisfies ResolveTaskDescription,
    getId: StudioPackAgentId.AGENT_MANAGER,
  },
  {
    id: "studio-automation-manager",
    title: "Automation Manager",
    icon: "icon://Zap?color=amber",
    description: "Create, configure, and run automations with triggers",
    selectedTools: [
      "AUTOMATION_CREATE",
      "AUTOMATION_GET",
      "AUTOMATION_LIST",
      "AUTOMATION_UPDATE",
      "AUTOMATION_DELETE",
      "AUTOMATION_TRIGGER_ADD",
      "AUTOMATION_TRIGGER_REMOVE",
      "AUTOMATION_RUN",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ] as readonly string[] | null,
    selectedConnections: null as
      | readonly ("self" | "registry" | "community-registry")[]
      | null,
    instructions: AUTOMATION_MANAGER_INSTRUCTIONS,
    welcomeMessage: (async (ctx: WelcomeContext) => [
      {
        type: "text",
        text: ctx.hasCustomAgents
          ? "Hi! I'm your Automation Manager. Automations put your agents on autopilot — pick an agent, give it a schedule (cron) or a trigger (event/webhook), and it runs in the background. Want me to suggest a few automations based on the agents you've already got?"
          : "Hi! I'm your Automation Manager. Automations run your agents on autopilot — on a schedule (cron) or when an event fires (webhook, inbound message). You'll need to create an agent first — once the Agent Manager has helped you set one up, come back and I'll put it on a trigger.",
      },
    ]) satisfies BuildWelcomeMessage,
    resolveTaskDescription: (async ({ orgId, ctx }) => {
      const automations = await ctx.storage.automations.list(orgId);
      if (automations.length === 0) return "Automate a task";
      if (automations.every((a) => !a.active)) {
        return "Reactivate an automation";
      }
      return null;
    }) satisfies ResolveTaskDescription,
    getId: StudioPackAgentId.AUTOMATION_MANAGER,
  },
  {
    id: "studio-connection-manager",
    title: "Connection Manager",
    icon: "icon://Link01?color=cyan",
    description: "Create, configure, test, and manage connections",
    selectedTools: [
      "COLLECTION_CONNECTIONS_CREATE",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
      "COLLECTION_CONNECTIONS_UPDATE",
      "COLLECTION_CONNECTIONS_DELETE",
      "CONNECTION_TEST",
    ] as readonly string[] | null,
    selectedConnections: null as
      | readonly ("self" | "registry" | "community-registry")[]
      | null,
    instructions: CONNECTION_MANAGER_INSTRUCTIONS,
    welcomeMessage: (async (_ctx: WelcomeContext) => [
      {
        type: "text",
        text: "Hi! I'm your Connection Manager. I add, configure, and test MCP connections. What do you want to plug in?",
      },
    ]) satisfies BuildWelcomeMessage,
    resolveTaskDescription: (async ({ orgId, ctx }) => {
      const { items } = await ctx.storage.connections.list(orgId);
      const userConnections = items.filter(
        (c) => !isWellKnownSeededConnection(orgId, c.id),
      );
      if (userConnections.length === 0) return "Connect a new MCP";
      if (userConnections.some((c) => c.status === "error")) {
        return "Fix a broken connection";
      }
      return null;
    }) satisfies ResolveTaskDescription,
    getId: StudioPackAgentId.CONNECTION_MANAGER,
  },
  {
    id: "studio-store-manager",
    title: "Store Manager",
    icon: "icon://Store01?color=emerald",
    description:
      "Browse the Deco Store and Community Registry, recommend MCPs, and guide installations.",
    // null = all tools from the connection(s) below
    selectedTools: null as readonly string[] | null,
    selectedConnections: ["registry", "community-registry"] as readonly (
      | "self"
      | "registry"
      | "community-registry"
    )[],
    instructions: STORE_MANAGER_INSTRUCTIONS,
    welcomeMessage: (async (_ctx: WelcomeContext) => [
      {
        type: "text",
        text: "Hey — I browse the Deco Store and Community Registry for installable MCPs. What problem are you trying to solve?",
      },
    ]) satisfies BuildWelcomeMessage,
    resolveTaskDescription: (async ({ orgId, ctx }) => {
      const { items } = await ctx.storage.connections.list(orgId);
      const userConnections = items.filter(
        (c) => !isWellKnownSeededConnection(orgId, c.id),
      );
      if (userConnections.length === 0) return "Browse the Deco Store";
      return null;
    }) satisfies ResolveTaskDescription,
    getId: StudioPackAgentId.STORE_MANAGER,
  },
] as const;

type StudioPackAgent = (typeof STUDIO_PACK_AGENTS)[number];

export function findStudioPackAgentByMcpId(
  virtualMcpId: string,
): StudioPackAgent | null {
  return (
    STUDIO_PACK_AGENTS.find((a) => virtualMcpId.startsWith(`${a.id}_`)) ?? null
  );
}

export function studioPackOrder(agent: StudioPackAgent): number {
  return STUDIO_PACK_AGENTS.findIndex((a) => a.id === agent.id);
}

export async function resolveStudioPackRuntime(
  agent: StudioPackAgent,
  rt: RuntimeResolveContext,
): Promise<ResolvedRuntime> {
  if ("resolveRuntime" in agent) {
    return agent.resolveRuntime(rt);
  }
  return {
    instructions: agent.instructions,
    selectedTools: agent.selectedTools,
  };
}

export async function resolveStudioPackTaskDescription(
  agent: StudioPackAgent,
  c: TaskDescriptionContext,
): Promise<string | null> {
  if ("resolveTaskDescription" in agent) {
    return agent.resolveTaskDescription(c);
  }
  return null;
}

export async function installStudioPack(
  orgId: string,
  createdBy: string,
  virtualMcpStorage: VirtualMCPStorage,
): Promise<void> {
  const connectionForKey: Record<
    "self" | "registry" | "community-registry",
    string
  > = {
    self: WellKnownOrgMCPId.SELF(orgId),
    registry: WellKnownOrgMCPId.REGISTRY(orgId),
    "community-registry": WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId),
  };

  await Promise.all(
    STUDIO_PACK_AGENTS.map(async (agent) => {
      const agentId = agent.getId(orgId);

      // Idempotent: skip if this agent already exists in the org. Existing
      // orgs pre-dating Store Manager already have the other three; we only
      // backfill what's missing.
      const existing = await virtualMcpStorage.findById(agentId, orgId);
      if (existing) return;

      const connectionKeys = agent.selectedConnections ?? ["self"];
      const connectionIds = connectionKeys.map((k) => connectionForKey[k]);

      await virtualMcpStorage.create(
        orgId,
        createdBy,
        {
          title: agent.title,
          description: agent.description,
          icon: agent.icon,
          status: "active",
          pinned: false,
          metadata: {
            instructions: agent.instructions,
          },
          connections: connectionIds.map((connection_id) => ({
            connection_id,
            selected_tools: agent.selectedTools
              ? [...agent.selectedTools]
              : null,
            selected_resources: null,
            selected_prompts: null,
          })),
        },
        { id: agentId },
      );
    }),
  );
}
