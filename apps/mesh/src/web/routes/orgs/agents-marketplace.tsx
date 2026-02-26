/**
 * Agents Marketplace — /$org/$project/hire
 *
 * Curated grid of pre-built agents for e-commerce storefronts.
 * All data is mocked. Navigates to agent detail on card click.
 */

import { Page } from "@/web/components/page";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deco/ui/components/breadcrumb.tsx";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  BarChart10,
  Eye,
  File06,
  Package,
  SearchMd,
  TrendUp01,
} from "@untitledui/icons";
import type { ReactNode } from "react";
import { cn } from "@deco/ui/lib/utils.ts";

// ─── Catalog data ──────────────────────────────────────────────────────────────

export interface CatalogAgent {
  id: string;
  name: string;
  description: string;
  category: string;
  hired: boolean;
  connections: string[];
  approvalPct: number;
  tasksRun: number;
  lastRun: string | null;
}

export const CATALOG: CatalogAgent[] = [
  {
    id: "blog-post-generator",
    name: "Blog Post Generator",
    description:
      "Researches, writes and publishes SEO-optimized blog posts using your brand voice",
    category: "Content",
    hired: true,
    connections: ["Google Search Console", "Shopify", "GitHub"],
    approvalPct: 91,
    tasksRun: 24,
    lastRun: "2h ago",
  },
  {
    id: "seo-optimizer",
    name: "SEO Optimizer",
    description:
      "Identifies keyword gaps and proposes on-page improvements across your catalog",
    category: "SEO",
    hired: false,
    connections: ["Google Search Console", "Google Analytics"],
    approvalPct: 87,
    tasksRun: 0,
    lastRun: null,
  },
  {
    id: "performance-monitor",
    name: "Performance Monitor",
    description:
      "Watches Core Web Vitals daily and surfaces regressions before they hurt conversions",
    category: "Performance",
    hired: false,
    connections: ["PageSpeed API"],
    approvalPct: 94,
    tasksRun: 0,
    lastRun: null,
  },
  {
    id: "catalog-manager",
    name: "Catalog Manager",
    description:
      "Detects missing images, broken variants, and pricing inconsistencies in your catalog",
    category: "Catalog",
    hired: false,
    connections: ["VTEX", "Shopify"],
    approvalPct: 88,
    tasksRun: 0,
    lastRun: null,
  },
  {
    id: "conversion-analyst",
    name: "Conversion Analyst",
    description:
      "Analyzes funnel drop-off and proposes A/B test hypotheses backed by your analytics data",
    category: "CRO",
    hired: false,
    connections: ["Google Analytics", "Hotjar"],
    approvalPct: 82,
    tasksRun: 0,
    lastRun: null,
  },
  {
    id: "competitor-tracker",
    name: "Competitor Tracker",
    description:
      "Monitors competitor pricing, promotions, and new arrivals weekly",
    category: "Intelligence",
    hired: false,
    connections: [],
    approvalPct: 79,
    tasksRun: 0,
    lastRun: null,
  },
];

// ─── Avatar colors ─────────────────────────────────────────────────────────────

const AVATAR_COLORS: Record<string, string> = {
  "blog-post-generator": "bg-violet-100 text-violet-700",
  "seo-optimizer": "bg-blue-100 text-blue-700",
  "performance-monitor": "bg-orange-100 text-orange-700",
  "catalog-manager": "bg-emerald-100 text-emerald-700",
  "conversion-analyst": "bg-rose-100 text-rose-700",
  "competitor-tracker": "bg-amber-100 text-amber-700",
};

const AGENT_ICONS: Record<string, ReactNode> = {
  "blog-post-generator": <File06 size={18} />,
  "seo-optimizer": <SearchMd size={18} />,
  "performance-monitor": <BarChart10 size={18} />,
  "catalog-manager": <Package size={18} />,
  "conversion-analyst": <TrendUp01 size={18} />,
  "competitor-tracker": <Eye size={18} />,
};

// Connection favicon domains
const CONNECTION_DOMAINS: Record<string, string> = {
  "Google Search Console": "search.google.com",
  "Google Analytics": "analytics.google.com",
  Shopify: "shopify.com",
  GitHub: "github.com",
  "PageSpeed API": "developers.google.com",
  VTEX: "vtex.com",
  Hotjar: "hotjar.com",
};

// ─── AgentCard ─────────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  onClick,
}: {
  agent: CatalogAgent;
  onClick: () => void;
}) {
  const avatarColor =
    AVATAR_COLORS[agent.id] ?? "bg-muted text-muted-foreground";
  const icon = AGENT_ICONS[agent.id] ?? (
    <span className="text-sm font-bold">{agent.name[0]}</span>
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col gap-0 rounded-xl border border-border bg-card text-left hover:shadow-sm transition-shadow cursor-pointer overflow-hidden"
    >
      {/* Card body */}
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3 flex-1">
        {/* Avatar + name row */}
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "shrink-0 flex items-center justify-center size-10 rounded-xl",
              avatarColor,
            )}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground leading-tight">
                {agent.name}
              </span>
              {agent.hired && (
                <Badge
                  variant="success"
                  className="text-[10px] px-1.5 py-0 h-4"
                >
                  Hired
                </Badge>
              )}
            </div>
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 w-fit text-muted-foreground"
            >
              {agent.category}
            </Badge>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
          {agent.description}
        </p>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        {/* Connection favicons */}
        <div className="flex items-center gap-1.5">
          {agent.connections.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">
              No connections
            </span>
          ) : (
            agent.connections.slice(0, 4).map((conn) => {
              const domain = CONNECTION_DOMAINS[conn] ?? "google.com";
              return (
                <img
                  key={conn}
                  src={`https://www.google.com/s2/favicons?domain=${domain}&sz=16`}
                  alt={conn}
                  title={conn}
                  className="size-4 rounded-sm"
                />
              );
            })
          )}
          {agent.connections.length > 4 && (
            <span className="text-[11px] text-muted-foreground">
              +{agent.connections.length - 4}
            </span>
          )}
        </div>

        {/* Approval pct */}
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">
            {agent.approvalPct}% approval
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AgentsMarketplacePage() {
  const { org, project } = useProjectContext();
  const navigate = useNavigate();

  return (
    <Page>
      <Page.Header>
        <Page.Header.Left>
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Agents</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Page.Header.Left>
      </Page.Header>

      <Page.Content>
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              Pre-built agents for e-commerce storefronts.
            </p>
            <p className="text-sm text-muted-foreground">
              Hire them to automate your operations.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {CATALOG.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onClick={() =>
                  navigate({
                    to: "/$org/$project/hire/$agentId",
                    params: {
                      org: org.slug,
                      project: project.slug,
                      agentId: agent.id,
                    },
                  })
                }
              />
            ))}
          </div>
        </div>
      </Page.Content>
    </Page>
  );
}
