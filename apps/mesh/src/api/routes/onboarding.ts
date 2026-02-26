/**
 * Authenticated Onboarding Routes
 *
 * Post-login onboarding claim flow — resolving org options from a diagnostic
 * token and claiming the session by creating/joining an org + project.
 *
 * These routes are mounted BEFORE the MeshContext middleware and are excluded
 * from context injection via shouldSkipMeshContext (API_ONBOARDING prefix).
 * Auth is checked manually via the Better Auth session API.
 *
 * Routes:
 *   GET  /api/onboarding/resolve?token=...  — Resolve org options from a diagnostic token
 *   POST /api/onboarding/claim              — Claim session by creating/joining an org
 *   POST /api/onboarding/interview-results  — Persist interview goals/challenges to org context
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Kysely } from "kysely";
import type { auth } from "../../auth";
import type { Database } from "../../storage/types";
import type {
  DiagnosticResult,
  InterviewResults,
  AgentRecommendation,
  WebPerformanceResult,
  SeoResult,
  TechStackResult,
} from "../../diagnostic/types";
import { DiagnosticSessionStorage } from "../../storage/diagnostic-sessions";
import { ProjectsStorage } from "../../storage/projects";

// ============================================================================
// Local Helpers
// ============================================================================

/**
 * Convert a string to a URL-friendly slug.
 * Duplicated locally from auth/index.ts to avoid importing from a module
 * with complex initialization side effects.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}


/**
 * Extract a human-readable company name from an AI-generated description.
 * Heuristic: descriptions typically start with "CompanyName is ..." —
 * extract the words before the first " is " or " are ".
 * Fallback: use the hostname from the storefront URL.
 */
function extractCompanyName(
  description: string | undefined,
  fallbackUrl: string,
): string {
  if (description) {
    // Try "CompanyName is ..." / "CompanyName are ..."
    const isMatch = description.match(/^(.+?)\s+(?:is|are)\s/i);
    if (isMatch?.[1]) {
      const candidate = isMatch[1].trim();
      // Sanity check: reject overly long candidates (probably a sentence, not a name)
      if (candidate.length <= 60) {
        return candidate;
      }
    }

    // Fallback: use the first line / sentence of the description
    const firstLine = description.split(/[\n.]/)[0]?.trim();
    if (firstLine && firstLine.length <= 60) {
      return firstLine;
    }
  }

  // Last resort: derive from URL hostname
  try {
    const parsed = new URL(fallbackUrl);
    // "mystore.com" → "mystore"
    return parsed.hostname.split(".")[0] ?? parsed.hostname;
  } catch {
    return "My Store";
  }
}

// ============================================================================
// Request Schemas
// ============================================================================

const ResolveQuerySchema = z.object({
  token: z.string().min(1),
});

const ClaimBodySchema = z.object({
  token: z.string().min(1),
  action: z.enum(["create", "join"]),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
});

const InterviewResultsBodySchema = z.object({
  token: z.string().min(1),
  organizationId: z.string().min(1),
  goals: z.array(z.string()),
  challenges: z.array(z.string()),
  priorities: z.array(z.string()),
});

const RecommendationsQuerySchema = z.object({
  token: z.string().min(1),
  organizationId: z.string().min(1),
});

// ============================================================================
// Route Factory
// ============================================================================

/**
 * Create authenticated onboarding routes with an injected database and auth instance.
 * Called from app.ts before the MeshContext middleware is mounted.
 */
export function createOnboardingRoutes(
  db: Kysely<Database>,
  authInstance: typeof auth,
) {
  const app = new Hono();
  const sessionStorage = new DiagnosticSessionStorage(db);
  const projectsStorage = new ProjectsStorage(db);

  // --------------------------------------------------------------------------
  // Auth helper
  // --------------------------------------------------------------------------

  /**
   * Extract and validate the Better Auth session from the current request.
   * Returns the session user (id, email, name) or null if not authenticated.
   */
  async function getSessionUser(
    c: Context,
  ): Promise<{ id: string; email: string; name: string } | null> {
    const session = await authInstance.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session?.user) {
      return null;
    }

    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? "",
    };
  }

  // --------------------------------------------------------------------------
  // GET /resolve?token=... — Resolve org options from a diagnostic token
  // --------------------------------------------------------------------------

  app.get("/resolve", async (c) => {
    // 1. Validate query params
    const parsed = ResolveQuerySchema.safeParse({
      token: c.req.query("token"),
    });
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid query parameters",
          details: parsed.error.flatten().fieldErrors,
        },
        400,
      );
    }
    const { token } = parsed.data;

    // 2. Auth check
    const user = await getSessionUser(c);
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // 3. Load diagnostic session
    const diagnosticSession = await sessionStorage.findByToken(token);
    if (!diagnosticSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    // 4. Extract company name from AI description
    const companyName = extractCompanyName(
      diagnosticSession.results.companyContext?.description,
      diagnosticSession.url,
    );

    // 5. Extract email domain
    const emailDomain = user.email.split("@")[1] ?? "";

    // 6. Find organizations matching the email domain
    // Query the database directly for orgs whose slug or name contains the domain
    let matchingOrgs: Array<{
      id: string;
      name: string;
      slug: string;
      memberCount: number;
    }> = [];

    if (emailDomain) {
      try {
        const domainPattern = `%${emailDomain}%`;
        const orgRows = await (db as Kysely<Database>)
          .selectFrom("organization")
          .select(["id", "name", "slug"])
          .where((eb) =>
            eb.or([
              eb("slug", "like", domainPattern),
              eb("name", "like", domainPattern),
            ]),
          )
          .limit(5)
          .execute();

        matchingOrgs = orgRows.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          memberCount: 0, // Member count not needed for initial resolution
        }));
      } catch {
        // Non-fatal — just return empty matching orgs
        matchingOrgs = [];
      }
    }

    // 7. Return resolve response
    return c.json(
      {
        session: {
          token: diagnosticSession.token,
          url: diagnosticSession.url,
          companyName,
        },
        suggestedOrgName: companyName,
        matchingOrgs,
      },
      200,
    );
  });

  // --------------------------------------------------------------------------
  // POST /claim — Claim session by creating or joining an org + project
  // --------------------------------------------------------------------------

  app.post("/claim", async (c) => {
    // 1. Parse and validate request body
    let body: z.infer<typeof ClaimBodySchema>;
    try {
      const raw = await c.req.json();
      const parsed = ClaimBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid request body",
            details: parsed.error.flatten().fieldErrors,
          },
          400,
        );
      }
      body = parsed.data;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // 2. Auth check
    const user = await getSessionUser(c);
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // 3. Load diagnostic session
    const diagnosticSession = await sessionStorage.findByToken(body.token);
    if (!diagnosticSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    // 4. Guard: session already claimed
    if (diagnosticSession.organizationId) {
      return c.json({ error: "Session already claimed" }, 409);
    }

    let organizationId: string;
    let organizationSlug: string;

    // 5. Create or join org
    if (body.action === "create") {
      // Determine org name: prefer explicit body param, fallback to AI extraction
      const orgName =
        body.orgName?.trim() ||
        extractCompanyName(
          diagnosticSession.results.companyContext?.description,
          diagnosticSession.url,
        );

      const baseSlug = slugify(orgName);

      // Attempt org creation — retry with random suffix on slug conflict
      let createdOrg: { id: string; slug: string } | null = null;
      const maxAttempts = 3;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidateSlug =
          attempt === 0
            ? baseSlug
            : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

        try {
          const response = await authInstance.api.createOrganization({
            body: {
              name: attempt === 0 ? orgName : `${orgName} (${candidateSlug})`,
              slug: candidateSlug,
              userId: user.id,
            },
          });

          if (response) {
            createdOrg = { id: response.id, slug: response.slug };
            break;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isConflict =
            message.includes("already exists") ||
            message.includes("unique") ||
            message.includes("duplicate") ||
            message.includes("UNIQUE");

          if (!isConflict || attempt === maxAttempts - 1) {
            console.error("[onboarding/claim] Org creation failed:", err);
            return c.json({ error: "Failed to create organization" }, 500);
          }
          // Loop continues with next slug candidate
        }
      }

      if (!createdOrg) {
        return c.json(
          { error: "Failed to create organization after retries" },
          500,
        );
      }

      // Set newly created org as active
      try {
        await authInstance.api.setActiveOrganization({
          headers: c.req.raw.headers,
          body: { organizationId: createdOrg.id },
        });
      } catch {
        // Non-fatal — session association proceeds regardless
      }

      organizationId = createdOrg.id;
      organizationSlug = createdOrg.slug;
    } else {
      // action === "join"
      if (!body.orgId) {
        return c.json({ error: "orgId is required for action 'join'" }, 400);
      }

      // Look up the org to get its slug
      const orgRow = await (db as Kysely<Database>)
        .selectFrom("organization")
        .select(["id", "slug"])
        .where("id", "=", body.orgId)
        .executeTakeFirst();

      if (!orgRow) {
        return c.json({ error: "Organization not found" }, 404);
      }

      // Set as active org (Better Auth will error if user is not a member)
      try {
        await authInstance.api.setActiveOrganization({
          headers: c.req.raw.headers,
          body: { organizationId: body.orgId },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          { error: "Failed to join organization", details: message },
          403,
        );
      }

      organizationId = orgRow.id;
      organizationSlug = orgRow.slug;
    }

    // 6. Create "Storefront" project
    const projectSlugBase = "storefront";
    const projectName = "Storefront";

    let projectId: string | undefined;
    let projectSlug: string | undefined;
    const maxProjectAttempts = 3;

    for (let attempt = 0; attempt < maxProjectAttempts; attempt++) {
      const candidateSlug =
        attempt === 0
          ? projectSlugBase
          : `${projectSlugBase}-${Math.random().toString(36).slice(2, 6)}`;

      try {
        const project = await projectsStorage.create({
          organizationId,
          slug: candidateSlug,
          name: projectName,
          description: `Storefront diagnostic for ${diagnosticSession.url}`,
        });
        projectId = project.id;
        projectSlug = project.slug;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isConflict =
          message.includes("already exists") ||
          message.includes("unique") ||
          message.includes("duplicate") ||
          message.includes("UNIQUE");

        if (!isConflict || attempt === maxProjectAttempts - 1) {
          console.error("[onboarding/claim] Project creation failed:", err);
          // Non-fatal — proceed without project association
          break;
        }
      }
    }

    // 7. Associate session with org (and project if created)
    await sessionStorage.associateOrg(body.token, organizationId, projectId);

    // 8. Return claim response
    return c.json(
      {
        organizationId,
        organizationSlug,
        projectId: projectId ?? null,
        projectSlug: projectSlug ?? null,
      },
      200,
    );
  });

  // --------------------------------------------------------------------------
  // POST /interview-results — Persist interview goals/challenges to org context
  // --------------------------------------------------------------------------

  app.post("/interview-results", async (c) => {
    // 1. Parse and validate request body
    let body: z.infer<typeof InterviewResultsBodySchema>;
    try {
      const raw = await c.req.json();
      const parsed = InterviewResultsBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: "Invalid request body",
            details: parsed.error.flatten().fieldErrors,
          },
          400,
        );
      }
      body = parsed.data;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // 2. Auth check
    const user = await getSessionUser(c);
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // 3. Load diagnostic session
    const diagnosticSession = await sessionStorage.findByToken(body.token);
    if (!diagnosticSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    // 4. Verify session belongs to the specified org
    if (
      diagnosticSession.organizationId &&
      diagnosticSession.organizationId !== body.organizationId
    ) {
      return c.json(
        { error: "Session does not belong to this organization" },
        403,
      );
    }

    // 5. Persist interview results into the diagnostic session's results JSON
    const interviewResults = {
      goals: body.goals,
      challenges: body.challenges,
      priorities: body.priorities,
      completedAt: new Date().toISOString(),
    };

    try {
      await sessionStorage.updateResults(
        body.token,
        "interviewResults" as keyof DiagnosticResult,
        interviewResults,
      );
    } catch (err) {
      console.error(
        "[onboarding/interview-results] Failed to persist results:",
        err,
      );
      return c.json({ error: "Failed to persist interview results" }, 500);
    }

    // 6. Return success
    return c.json({ success: true }, 200);
  });

  // --------------------------------------------------------------------------
  // GET /recommendations?token=...&organizationId=... — Score Virtual MCPs
  // --------------------------------------------------------------------------

  app.get("/recommendations", async (c) => {
    // 1. Validate query params
    const parsed = RecommendationsQuerySchema.safeParse({
      token: c.req.query("token"),
      organizationId: c.req.query("organizationId"),
    });
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid query parameters",
          details: parsed.error.flatten().fieldErrors,
        },
        400,
      );
    }
    const { token, organizationId } = parsed.data;

    // 2. Auth check
    const user = await getSessionUser(c);
    if (!user) {
      return c.json({ error: "Authentication required" }, 401);
    }

    // 3. Load diagnostic session
    const diagnosticSession = await sessionStorage.findByToken(token);
    if (!diagnosticSession) {
      return c.json({ error: "Session not found" }, 404);
    }

    // 4. Load Virtual MCPs (stored as connections with type VIRTUAL) and their aggregations
    const virtualMcpRows = await db
      .selectFrom("connections")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("connection_type", "=", "VIRTUAL")
      .where("status", "=", "active")
      .execute();

    if (virtualMcpRows.length === 0) {
      return c.json({ recommendations: [] }, 200);
    }

    const virtualMcpIds = virtualMcpRows.map((r) => r.id);

    // Load connection aggregations for all virtual MCPs in one query (only direct deps)
    const aggregationRows = await db
      .selectFrom("connection_aggregations")
      .selectAll()
      .where("parent_connection_id", "in", virtualMcpIds)
      .where("dependency_mode", "=", "direct")
      .execute();

    // Group aggregations by parent ID
    const aggsByParent = new Map<
      string,
      Array<{ child_connection_id: string }>
    >();
    for (const agg of aggregationRows) {
      const existing = aggsByParent.get(agg.parent_connection_id) ?? [];
      existing.push({ child_connection_id: agg.child_connection_id });
      aggsByParent.set(agg.parent_connection_id, existing);
    }

    // Collect all unique child connection IDs to batch-load connection details
    const allChildConnectionIds = new Set<string>();
    for (const agg of aggregationRows) {
      allChildConnectionIds.add(agg.child_connection_id);
    }

    // Load child connection details in one query
    const childConnectionRows =
      allChildConnectionIds.size > 0
        ? await db
            .selectFrom("connections")
            .select([
              "id",
              "title",
              "connection_url",
              "connection_headers",
              "status",
            ])
            .where("id", "in", Array.from(allChildConnectionIds))
            .execute()
        : [];

    const childConnectionMap = new Map(
      childConnectionRows.map((c) => [c.id, c]),
    );

    // 5. Score each Virtual MCP against diagnostic results + interview results
    const diagnosticResults = diagnosticSession.results;
    const interviewResults =
      "interviewResults" in diagnosticResults
        ? (diagnosticResults as Record<string, unknown>).interviewResults
        : null;

    type ScoredAgent = {
      agentId: string;
      agentTitle: string;
      agentDescription: string | null;
      agentIcon: string | null;
      score: number;
      reasons: string[];
      requiredConnections: AgentRecommendation["requiredConnections"];
    };

    const scored: ScoredAgent[] = virtualMcpRows
      .map((vmcp) => {
        // Filter out Decopilot (its ID starts with "decopilot_")
        if (vmcp.id.startsWith("decopilot_")) {
          return null;
        }

        // Parse metadata for instructions (metadata may be a string or object depending on DB driver)
        let instructions: string | null = null;
        if (vmcp.metadata) {
          try {
            const raw = vmcp.metadata;
            const meta =
              typeof raw === "string"
                ? (JSON.parse(raw) as { instructions?: string | null })
                : (raw as { instructions?: string | null });
            instructions = meta.instructions ?? null;
          } catch {
            // ignore parse errors
          }
        }

        // Build searchable text from the Virtual MCP
        const searchText = [
          vmcp.title,
          vmcp.description ?? "",
          instructions ?? "",
        ]
          .join(" ")
          .toLowerCase();

        let score = 0;
        const reasons: string[] = [];

        // ---- Diagnostic signal matching ----

        const webPerf = (diagnosticResults as DiagnosticResult).webPerformance;
        const seo = (diagnosticResults as DiagnosticResult).seo;
        const techStack = (diagnosticResults as DiagnosticResult).techStack;

        // Performance/speed keywords
        const perfKeywords =
          /\b(performance|speed|lcp|cwv|core.web|loading|lighthouse|pagespeed|optimization|optim)\b/i;
        if (perfKeywords.test(searchText)) {
          const perfData = webPerf as WebPerformanceResult | null | undefined;
          const hasPoorPerf =
            perfData?.mobile?.lcp?.rating === "poor" ||
            perfData?.mobile?.lcp?.rating === "needs-improvement" ||
            (perfData?.mobile?.performanceScore ?? 100) < 70 ||
            (perfData?.desktop?.performanceScore ?? 100) < 70;

          if (hasPoorPerf) {
            score += 30;
            const lcpRating = perfData?.mobile?.lcp?.rating;
            if (lcpRating === "poor" || lcpRating === "needs-improvement") {
              reasons.push(
                `Your site's LCP is rated '${lcpRating}' — this agent can help optimize loading performance`,
              );
            } else {
              reasons.push(
                "Your site's performance scores need improvement — this agent can help optimize speed",
              );
            }
          }
        }

        // SEO keywords
        const seoKeywords =
          /\b(seo|meta|search|ranking|sitemap|robots|og.tag|opengraph|canonical|heading|schema|structured.data)\b/i;
        if (seoKeywords.test(searchText)) {
          const seoResult = seo as SeoResult | null | undefined;
          const hasSeoIssues =
            !seoResult?.metaDescription ||
            !seoResult?.hasRobotsTxt ||
            !seoResult?.hasSitemap ||
            (seoResult?.ogTags && Object.keys(seoResult.ogTags).length === 0);

          if (hasSeoIssues) {
            score += 30;
            const issues: string[] = [];
            if (!seoResult?.metaDescription)
              issues.push("missing meta description");
            if (!seoResult?.hasRobotsTxt) issues.push("no robots.txt");
            if (!seoResult?.hasSitemap) issues.push("no sitemap");
            if (issues.length > 0) {
              reasons.push(
                `Your site has SEO issues (${issues.slice(0, 2).join(", ")}) — this agent can help improve search visibility`,
              );
            } else {
              reasons.push(
                "Your site has SEO opportunities — this agent can help improve search rankings",
              );
            }
          }
        }

        // Content/copy keywords
        const contentKeywords =
          /\b(content|copy|description|text|blog|article|product.description|copywriting|writing)\b/i;
        if (contentKeywords.test(searchText)) {
          const companyCtx = (diagnosticResults as DiagnosticResult)
            .companyContext;
          const hasShortDescription =
            !companyCtx?.description || companyCtx.description.length < 100;

          if (hasShortDescription) {
            score += 30;
            reasons.push(
              "Your site's company description is incomplete — this agent can help create compelling content",
            );
          }
        }

        // Platform-specific keywords
        const techStackResult = techStack as TechStackResult | null | undefined;
        const platformName =
          techStackResult?.platform?.name?.toLowerCase() ?? "";
        if (platformName) {
          const platformPattern = new RegExp(
            `\\b${platformName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "i",
          );
          if (platformPattern.test(searchText)) {
            score += 25;
            reasons.push(
              `This agent is optimized for ${techStackResult?.platform?.name} — your detected platform`,
            );
          }
        }

        // E-commerce base relevance (mild positive for all storefront users)
        const ecommerceKeywords =
          /\b(e.commerce|ecommerce|store|shop|product|catalog|cart|checkout|order|vtex|shopify|commerce)\b/i;
        if (ecommerceKeywords.test(searchText)) {
          score += 10;
        }

        // ---- Interview goal matching ----

        if (interviewResults && typeof interviewResults === "object") {
          const ir = interviewResults as InterviewResults;
          const allGoalStrings = [
            ...(ir.goals ?? []),
            ...(ir.challenges ?? []),
            ...(ir.priorities ?? []),
          ];

          for (const goalStr of allGoalStrings) {
            const words = goalStr
              .toLowerCase()
              .split(/\W+/)
              .filter((w) => w.length > 3);

            for (const word of words) {
              if (searchText.includes(word)) {
                score += 20;
                // Only add one reason per goal string to avoid verbosity
                reasons.push(
                  `Matches your stated goal: "${goalStr.slice(0, 60)}${goalStr.length > 60 ? "..." : ""}"`,
                );
                break; // One reason per goal string
              }
            }
          }
        }

        // Build required connections list from aggregations
        const agentAggs = aggsByParent.get(vmcp.id) ?? [];
        const requiredConnections: AgentRecommendation["requiredConnections"] =
          agentAggs.map((agg) => {
            const conn = childConnectionMap.get(agg.child_connection_id);
            const isConfigured =
              !!conn &&
              conn.status === "active" &&
              (!!conn.connection_url || !!conn.connection_headers);

            return {
              title: conn?.title ?? agg.child_connection_id,
              connectionId: agg.child_connection_id,
              isConfigured,
            };
          });

        return {
          agentId: vmcp.id,
          agentTitle: vmcp.title,
          agentDescription: vmcp.description ?? null,
          agentIcon: vmcp.icon ?? null,
          score,
          reasons,
          requiredConnections,
        };
      })
      .filter((item): item is ScoredAgent => item !== null && item.score > 0);

    // 6. Sort by score descending, take top 3
    scored.sort((a, b) => b.score - a.score);
    const top3 = scored.slice(0, 3);

    // 7. Build response
    const recommendations: AgentRecommendation[] = top3.map((item) => ({
      agentId: item.agentId,
      agentTitle: item.agentTitle,
      agentDescription: item.agentDescription,
      agentIcon: item.agentIcon,
      reason:
        item.reasons.slice(0, 2).join(" Also, ") ||
        "This agent is relevant to your storefront goals.",
      score: Math.min(100, item.score),
      requiredConnections: item.requiredConnections,
    }));

    return c.json({ recommendations }, 200);
  });

  return app;
}
