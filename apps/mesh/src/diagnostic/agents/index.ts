/**
 * Diagnostic Agent Registry
 *
 * Barrel export of all 4 diagnostic agents and their registry structure.
 * The orchestrator (Plan 03) uses DIAGNOSTIC_AGENTS to run agents with appropriate arguments.
 *
 * Note: Agent signatures differ by design:
 * - seo and tech_stack: accept (crawl: CrawlResult)
 * - web_performance and company_context: accept (url: string, crawl: CrawlResult)
 * The orchestrator handles calling each agent with the correct arguments.
 */

export { runCompanyContextAgent } from "./company-context";
export type { CompanyContextResult } from "./company-context";

export { runSeoAgent } from "./seo";
export type { SeoResult, HeadingItem, StructuredDataItem } from "./seo";

export { runTechStackAgent } from "./tech-stack";
export type {
  TechStackResult,
  DetectedTechnology,
  PlatformDetection,
} from "./tech-stack";

export { runWebPerformanceAgent } from "./web-performance";
export type {
  WebPerformanceResult,
  StrategyScores,
  CoreWebVital,
  CruxData,
  ImageAuditResult,
  ImageIssue,
  HtmlSizeResult,
  VitalRating,
} from "./web-performance";

import type { CrawlResult } from "../crawl";
import type { CompanyContextResult } from "./company-context";
import type { SeoResult } from "./seo";
import type { TechStackResult } from "./tech-stack";
import type { WebPerformanceResult } from "./web-performance";
import { runCompanyContextAgent } from "./company-context";
import { runSeoAgent } from "./seo";
import { runTechStackAgent } from "./tech-stack";
import { runWebPerformanceAgent } from "./web-performance";

export interface DiagnosticAgentEntry<TResult> {
  id: string;
  name: string;
  run: (...args: unknown[]) => Promise<TResult>;
}

/**
 * Agent registry for the orchestrator (Plan 03).
 * Typed individually to preserve each agent's return type.
 */
export const DIAGNOSTIC_AGENTS = {
  web_performance: {
    id: "web_performance" as const,
    name: "Web Performance",
    run: (url: string, crawl: CrawlResult): Promise<WebPerformanceResult> =>
      runWebPerformanceAgent(url, crawl),
  },
  seo: {
    id: "seo" as const,
    name: "SEO Analysis",
    run: (crawl: CrawlResult): Promise<SeoResult> => runSeoAgent(crawl),
  },
  tech_stack: {
    id: "tech_stack" as const,
    name: "Tech Stack Detection",
    run: (crawl: CrawlResult): Promise<TechStackResult> =>
      runTechStackAgent(crawl),
  },
  company_context: {
    id: "company_context" as const,
    name: "Company Context",
    run: (url: string, crawl: CrawlResult): Promise<CompanyContextResult> =>
      runCompanyContextAgent(url, crawl),
  },
} as const;
