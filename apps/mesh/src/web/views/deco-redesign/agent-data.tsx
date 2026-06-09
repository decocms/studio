/**
 * Mock agent data (redesign)
 *
 * Resolves an agent profile from the `?agent` search param so the settings
 * pages can render any of the user's agents (current org, Farm Rio, Deco,
 * Monte Carlo). `?agent` absent → the current org. Mock only.
 */

import { Code02, SearchLg, Tag01 } from "@untitledui/icons";
import { USER_AGENTS } from "./mock-user";

export interface AgentConnection {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  /** Tailwind classes for the icon tile. */
  tile: string;
  icon: React.ReactNode;
  description: string;
  content: string;
}

export interface AgentProfile {
  /** The `?agent` value, or "" for the current org. */
  id: string;
  name: string;
  logo: string | null;
  blurb: string;
  connections: AgentConnection[];
  skills: AgentSkill[];
}

const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

const CONNECTIONS_CATALOG: Record<string, AgentConnection> = {
  vtex: {
    id: "vtex",
    name: "VTEX",
    description: "Catalog, orders, and storefront APIs",
    icon: favicon("vtex.com"),
  },
  ga: {
    id: "ga",
    name: "Google Analytics",
    description: "Traffic, conversion, and behavior",
    icon: favicon("analytics.google.com"),
  },
  gsc: {
    id: "gsc",
    name: "Search Console",
    description: "Indexing, impressions, and queries",
    icon: favicon("search.google.com"),
  },
  github: {
    id: "github",
    name: "GitHub",
    description: "Repos, issues, and pull requests",
    icon: favicon("github.com"),
  },
  slack: {
    id: "slack",
    name: "Slack",
    description: "Reach the team where they work",
    icon: favicon("slack.com"),
  },
  linear: {
    id: "linear",
    name: "Linear",
    description: "Turn requests into tracked work",
    icon: favicon("linear.app"),
  },
};

const SKILLS_CATALOG: Record<string, AgentSkill> = {
  "review-code": {
    id: "review-code",
    name: "Review Code",
    tile: "bg-violet-100 text-violet-600",
    icon: <Code02 size={16} />,
    description:
      'Structured code review — bugs, security, performance, and style with actionable feedback. Trigger with "review this code".',
    content: `# Code Review

Review code changes for bugs, security issues, performance regressions, and
style violations. Produces prioritised, actionable feedback.

# Review Workflow

Execute these steps in order for every review. Do not skip steps — a review
that catches a style nit but misses a security flaw has failed.

## Step 1: Understand Context
Before reading a single line of code, establish what the change is meant to do.`,
  },
  "seo-audit": {
    id: "seo-audit",
    name: "SEO audit",
    tile: "bg-blue-100 text-blue-600",
    icon: <SearchLg size={16} />,
    description:
      "Crawl the site, diagnose indexing and canonical issues, and open PRs with fixes. Runs nightly.",
    content: `# SEO audit

Pull Search Console + Analytics, find pages losing impressions, check
canonicals and structured data, and open a PR with fixes.`,
  },
  "pdp-schema": {
    id: "pdp-schema",
    name: "PDP schema",
    tile: "bg-emerald-100 text-emerald-600",
    icon: <Tag01 size={16} />,
    description:
      "Detect PDPs missing Product structured data, generate it from the catalog, and open a PR.",
    content: `# PDP schema

Add Product structured data to product detail pages. Generate from the
catalog, validate, and PR.`,
  },
};

interface AgentExtras {
  connectionIds: string[];
  skillIds: string[];
}

const AGENT_EXTRAS: Record<string, AgentExtras> = {
  "farm-rio": {
    connectionIds: ["vtex", "ga", "gsc"],
    skillIds: ["review-code"],
  },
  "deco-company": {
    connectionIds: ["github", "slack", "linear"],
    skillIds: ["review-code", "seo-audit"],
  },
  "monte-carlo": { connectionIds: ["vtex", "ga"], skillIds: [] },
};

const DEFAULT_EXTRAS: AgentExtras = {
  connectionIds: ["vtex", "ga", "gsc"],
  skillIds: ["review-code"],
};

function build(extras: AgentExtras) {
  return {
    connections: extras.connectionIds
      .map((id) => CONNECTIONS_CATALOG[id])
      .filter((c): c is AgentConnection => Boolean(c)),
    skills: extras.skillIds
      .map((id) => SKILLS_CATALOG[id])
      .filter((s): s is AgentSkill => Boolean(s)),
  };
}

/**
 * Resolve the agent to render. `agentId` comes from the `?agent` search param;
 * when it matches one of the user's mock agents we use its data, otherwise we
 * fall back to the current org.
 */
export function resolveAgent(
  agentId: string | undefined,
  fallback: { name: string; logo: string | null },
): AgentProfile {
  const mock = agentId ? USER_AGENTS.find((a) => a.id === agentId) : undefined;

  if (mock) {
    const { connections, skills } = build(
      AGENT_EXTRAS[mock.id] ?? DEFAULT_EXTRAS,
    );
    return {
      id: mock.id,
      name: mock.name,
      logo: mock.icon ?? null,
      blurb: mock.blurb,
      connections,
      skills,
    };
  }

  const { connections, skills } = build(DEFAULT_EXTRAS);
  return {
    id: "",
    name: fallback.name,
    logo: fallback.logo,
    blurb: "Powered by deco.cx",
    connections,
    skills,
  };
}
