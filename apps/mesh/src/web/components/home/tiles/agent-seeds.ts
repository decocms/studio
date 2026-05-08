/**
 * Shared seed data for the well-known agent templates that ship as
 * pinnable home tiles. The catalog and the starter board both consume
 * this so a tile's title/icon/description doesn't drift between
 * "Add tile" preview and the placed instance.
 */

export interface AgentSeed {
  id: string;
  title: string;
  icon: string;
  description: string;
}

/**
 * Identity used by Studio's own data tiles — recent tasks, recent
 * agents, connections, and workspace stats. The four read from the
 * same hooks as the rest of the app and present as a single "agent".
 */
export const STUDIO_AGENT = {
  id: "studio-agent",
  icon: "icon://Stars01?color=violet",
  name: "Studio Agent",
  description: "Live views of your Studio workspace.",
} as const;

export const AGENT_SEEDS = [
  {
    id: "site-editor",
    title: "deco Site Editor",
    icon: "/logos/deco%20logo.svg#agentcolor=brand-green",
    description: "Edit and ship changes to your deco site, conversation-first.",
  },
  {
    id: "site-diagnostics",
    title: "Site Diagnostics",
    icon: "icon://SearchRefraction?color=cyan",
    description: "Health check your site — broken links, slow pages, errors.",
  },
  {
    id: "ai-image",
    title: "Image Creator",
    icon: "icon://Image01?color=rose",
    description: "Generate, edit, and iterate on visuals from a prompt.",
  },
  {
    id: "ai-research",
    title: "Web Researcher",
    icon: "icon://SearchMd?color=green",
    description: "Run multi-source web research and summarise the findings.",
  },
  {
    id: "lean-canvas",
    title: "Lean Canvas",
    icon: "icon://FileCheck02?color=green",
    description: "Build a Lean Canvas for any product idea in minutes.",
  },
  {
    id: "studio-pack",
    title: "Studio Pack",
    icon: "icon://Package?color=blue",
    description: "Recruit a curated set of agents for studio work.",
  },
  {
    id: "self-healing-storefront",
    title: "Self-healing Storefront",
    icon: "icon://Zap?color=amber",
    description: "Watches your storefront and fixes issues as they appear.",
  },
] as const satisfies readonly AgentSeed[];

export type AgentSeedId = (typeof AGENT_SEEDS)[number]["id"];

const SEED_BY_ID = new Map(AGENT_SEEDS.map((a) => [a.id, a]));

export function getAgentSeed(id: AgentSeedId): AgentSeed {
  const seed = SEED_BY_ID.get(id);
  if (!seed) throw new Error(`Unknown agent seed: ${id}`);
  return seed;
}

export function agentCardType(id: string): string {
  return `agent.card.${id}`;
}
