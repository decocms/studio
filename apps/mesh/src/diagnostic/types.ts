/**
 * Diagnostic System Types
 *
 * Shared TypeScript types for the entire diagnostic system.
 * These types are used across the diagnostic pipeline, storage, and API.
 */

// ============================================================================
// Agent Identifiers
// ============================================================================

/** One identifier per diagnostic agent */
export type DiagnosticAgentId =
  | "web_performance"
  | "seo"
  | "tech_stack"
  | "company_context";

// ============================================================================
// Status Types
// ============================================================================

/** Per-agent status tracking for progressive updates */
export interface AgentStatus {
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string; // ISO 8601
  completedAt?: string;
  error?: string; // Only set on failure — NOT exposed differently from "no data"
}

/** Overall session status */
export type SessionStatus = "pending" | "running" | "completed" | "failed";

// ============================================================================
// Diagnostic Result Types
// ============================================================================

/** Web Performance results (from PSI + CrUX APIs) */
export interface WebPerformanceResult {
  // Core Web Vitals
  lcp?: {
    value: number;
    unit: "ms";
    rating: "good" | "needs-improvement" | "poor";
  };
  inp?: {
    value: number;
    unit: "ms";
    rating: "good" | "needs-improvement" | "poor";
  };
  cls?: {
    value: number;
    unit: "unitless";
    rating: "good" | "needs-improvement" | "poor";
  };
  // Performance scores (0-100)
  mobileScore?: number;
  desktopScore?: number;
  // CrUX data
  cruxData?: Record<string, unknown> | null;
  // Image audit findings
  imageAudit?: {
    issues: Array<{
      type: string;
      description: string;
      severity: "high" | "medium" | "low";
    }>;
    totalImages: number;
  };
  // HTML size analysis
  htmlSize?: {
    totalBytes: number;
    frameworkPayloadBytes?: number;
    structuredDataBytes?: number;
  };
  // Cache analysis
  cacheHeaders?: Record<string, string>;
}

/** SEO results (from HTML crawl) */
export interface SeoResult {
  title?: string;
  metaDescription?: string;
  ogTags?: Record<string, string>;
  canonicalUrl?: string;
  headingStructure?: { tag: string; text: string }[];
  robotsMeta?: string;
  hasRobotsTxt?: boolean;
  hasSitemap?: boolean;
  structuredData?: unknown[];
}

/** Tech Stack results (from HTML crawl + headers) */
export interface TechStackResult {
  platform?: { name: string; confidence: number }; // VTEX, Shopify, etc.
  analytics?: Array<{ name: string; confidence: number }>;
  cdn?: { name: string; confidence: number } | null;
  paymentProviders?: Array<{ name: string; confidence: number }>;
  chatTools?: Array<{ name: string; confidence: number }>;
  reviewWidgets?: Array<{ name: string; confidence: number }>;
  otherTech?: Array<{ name: string; confidence: number }>;
}

/** Company Context results (from multi-page crawl + LLM) */
export interface CompanyContextResult {
  description?: string; // Two paragraphs, conversational tone
  productSignals?: string[];
  targetAudience?: string;
  competitiveAngle?: string;
  crawledPages?: string[]; // URLs crawled for context
}

/** Complete diagnostic result set */
export interface DiagnosticResult {
  webPerformance?: WebPerformanceResult | null;
  seo?: SeoResult | null;
  techStack?: TechStackResult | null;
  companyContext?: CompanyContextResult | null;
}

// ============================================================================
// Session Type
// ============================================================================

/** Session as stored in DB (JSON columns for agents and results) */
export interface DiagnosticSession {
  id: string;
  token: string;
  url: string;
  normalizedUrl: string;
  status: SessionStatus;
  agents: Record<DiagnosticAgentId, AgentStatus>;
  results: DiagnosticResult;
  organizationId: string | null; // Nullable — filled post-login (Phase 21)
  projectId: string | null; // Nullable — filled post-login
  createdAt: string;
  updatedAt: string;
  expiresAt: string; // 7 days from creation
}
