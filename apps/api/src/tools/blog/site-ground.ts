import { z } from "zod";
import { toStudioStorageUri } from "@decocms/shared/harness/studio-storage-uri";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import type { StudioContext } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import {
  GROUNDING_PURPOSES,
  groundingRequestFor,
  type GroundingPurpose,
} from "./grounding-purpose";
import { EVIDENCE_KEY_PREFIX } from "./grounding-input";
import { groundSiteReport, VirtualMcpIdSchema } from "./site-tools";

/**
 * Reading the brand's own systems, once, as a call of its own.
 *
 * Every generator in this folder used to open with its own grounding pass, so a
 * person writing a post paid for the same sweep of the same store up to five
 * times in a session. Worse, the pass and the generation shared one HTTP
 * request: the two together ran past the edge proxy's limit, which answers 524
 * and hangs up while the server keeps working — the organization is billed for
 * a result nobody receives. A pass that is 120 seconds on its own, as the
 * campaign and post generators asked for, could never have returned at all.
 *
 * So the slow half is its own request and its answer is passed along. The prose
 * report is small enough to travel; the raw tool output is not, and it is also
 * the organization's own catalogue, so it stays server-side under a reference
 * that {@link BLOG_SITE_CATALOGUE} reads and deletes.
 *
 * `purpose` rather than a free-text brief: what the pass asks the store is
 * written here, not by the caller. The caller is a browser, the tools answer
 * from the brand's live systems, and "what do you want to know" is not a
 * question a request body should get to answer.
 */

/** What a caller may add to the task sentence — a seed, a campaign, a title. */
const MAX_FOCUS_CHARS = 2_000;

/** Matches the longest pass this is replacing; one request, nothing after it. */
const GROUNDING_TIMEOUT_MS = 75_000;

/**
 * Raw tool output smaller than this rides home inline instead of to storage.
 *
 * A store with two products produces a few kilobytes, and an object written,
 * fetched and deleted across three requests to carry them is three round trips
 * for nothing.
 */
const INLINE_EVIDENCE_LIMIT = 32_000;

export const BLOG_SITE_GROUND = defineTool({
  name: "BLOG_SITE_GROUND",
  description:
    "Read the brand's own connected systems — catalogue, analytics, whatever its virtual MCP carries — and report what is true about its business right now. Run once, then pass `report` to the generation tools so none of them has to look again. Returns an `evidenceUri` only when the raw output is too large to carry inline; BLOG_SITE_CATALOGUE reads it and deletes it.",
  annotations: {
    title: "Read the Site's Systems",
    /** Writes the raw evidence to the org's object storage when it is large. */
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    /** Calls whatever connections the virtual MCP carries. */
    openWorldHint: true,
  },

  requiresAiBudget: true,

  inputSchema: z.object({
    virtualMcpId: VirtualMcpIdSchema,
    purpose: z
      .enum(GROUNDING_PURPOSES)
      .describe(
        "What the findings are for. Decides what the pass asks the store; the question itself is not the caller's to write.",
      ),
    focus: z
      .string()
      .max(MAX_FOCUS_CHARS)
      .optional()
      .describe(
        "The one specific thing in hand — a campaign seed, a post's subject. Named in the task sentence so the pass knows what is relevant.",
      ),
    language: z
      .string()
      .max(64)
      .optional()
      .describe("The brand's language, so findings come back usable."),
  }),

  outputSchema: z.object({
    report: z
      .string()
      .describe(
        "What the pass found, as short markdown. Pass this to a generation tool as its `grounding`. Empty when there was nothing to ask or nothing came back.",
      ),
    outcome: z
      .enum(["no-site", "no-tools", "ok", "timeout", "failed"])
      .describe(
        "Why the report reads as it does. `no-site` and `no-tools` are worth telling the person about — one wants a connection, the other a permission.",
      ),
    toolNames: z
      .array(z.string())
      .describe("The read-only tools the site exposed."),
    evidence: z
      .string()
      .describe(
        "The raw tool output, when small enough to carry. Empty when it went to storage instead — see `evidenceUri`.",
      ),
    evidenceUri: z
      .string()
      .nullable()
      .describe(
        "Where the raw output was stored, when too large to carry. Hand it to BLOG_SITE_CATALOGUE, which reads it once and deletes it. Null when `evidence` is inline or there was none.",
      ),
    evidenceChars: z
      .number()
      .int()
      .describe("How much raw output the pass gathered, inline or stored."),
  }),

  modelSummary: (r) =>
    `Grounding ${r.outcome}: ${r.report.length} char(s) of findings from ${r.toolNames.length} tool(s), ${r.evidenceChars} char(s) of raw output${r.evidenceUri ? " (stored)" : ""}.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    await requireBlogAi(ctx, organizationId);

    const purpose = input.purpose as GroundingPurpose;
    const report = await groundSiteReport(ctx, organizationId, {
      virtualMcpId: input.virtualMcpId,
      language: input.language,
      label: "BLOG_SITE_GROUND",
      timeoutMs: GROUNDING_TIMEOUT_MS,
      ...groundingRequestFor(purpose, input.focus),
    });

    const evidenceChars = report.evidence.length;
    const inline = evidenceChars > 0 && evidenceChars <= INLINE_EVIDENCE_LIMIT;

    return {
      report: report.grounding,
      outcome: report.outcome,
      toolNames: report.toolNames,
      evidence: inline ? report.evidence : "",
      evidenceUri:
        inline || evidenceChars === 0
          ? null
          : await stashEvidence(ctx, report.evidence),
      evidenceChars,
    };
  },
});

/**
 * The raw output, parked where the next call can read it.
 *
 * Null rather than a throw when storage is unavailable or refuses: the report
 * is the part a generator needs, and losing the catalogue is a thinner campaign
 * rather than no campaign. The key carries the date so an orphan — the run was
 * abandoned before the catalogue call — is sweepable by prefix.
 */
async function stashEvidence(
  ctx: StudioContext,
  evidence: string,
): Promise<string | null> {
  const storage = ctx.objectStorage;
  if (!storage) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = `${EVIDENCE_KEY_PREFIX}${day}/${crypto.randomUUID()}.txt`;
  try {
    await storage.put(key, evidence, { contentType: "text/plain" });
    return toStudioStorageUri(key);
  } catch (err) {
    console.warn("[BLOG_SITE_GROUND] could not store the raw evidence", err);
    return null;
  }
}
