import { StudioPackAgentId } from "@decocms/mesh-sdk";
import { isWellKnownSeededConnection } from "./helpers";
import type {
  BuildWelcomeMessage,
  StudioPackChecklistItem,
  StudioPackConnectionKey,
  WelcomeContext,
} from "./types";

const INSTRUCTIONS = `<role>
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

export const storeManagerAgent = {
  id: "studio-store-manager",
  title: "Store Manager",
  icon: "icon://Store01?color=emerald",
  description:
    "Browse the Deco Store and Community Registry, recommend MCPs, and guide installations.",
  // null = all tools from the connection(s) below
  selectedTools: null as readonly string[] | null,
  selectedConnections: [
    "registry",
    "community-registry",
  ] as readonly StudioPackConnectionKey[],
  instructions: INSTRUCTIONS,
  welcomeMessage: (async (_ctx: WelcomeContext) => [
    {
      type: "text",
      text: "Hey — I browse the Deco Store and Community Registry for installable MCPs. What problem are you trying to solve?",
    },
  ]) satisfies BuildWelcomeMessage,
  checklist: [
    {
      label: "Browse the Deco Store",
      activeForm: "Browsing the Deco Store",
      action: {
        kind: "open-agent-thread",
        prompt:
          "Show me what's in the Deco Store and the Community Registry. Ask me what problem I'm trying to solve and recommend a few MCPs that fit.",
      },
      isCompleted: async ({ orgId, ctx }) => {
        const { items } = await ctx.storage.connections.list(orgId);
        return items.some((c) => !isWellKnownSeededConnection(orgId, c.id));
      },
    },
  ] as const satisfies readonly StudioPackChecklistItem[],
  getId: StudioPackAgentId.STORE_MANAGER,
} as const;
