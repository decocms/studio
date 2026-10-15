import { z } from "zod";
import { parseStudioStorageKey } from "@decocms/shared/harness/studio-storage-uri";
import type { StudioContext } from "../../core/studio-context";
import {
  type GroundingReport,
  type GroundingRequest,
  groundSiteReport,
} from "./site-tools";

/**
 * Grounding a caller already paid for, so a generator does not pay again.
 *
 * `BLOG_SITE_GROUND` reads the brand's systems in a request of its own and
 * hands back what it found. Every generator takes that here, which is what
 * keeps a generation request short enough to answer: the slow half already
 * happened, and the same sweep now serves the whole session instead of being
 * repeated per tool.
 *
 * Still optional. A caller that has not grounded gets the pass inline, as
 * before — an MCP client holding nothing but a virtual MCP id should not have
 * to make two calls to get one answer. That path is bounded tighter than it
 * used to be, because it has to share a request with the generation after it.
 */

/** A hair above what `BLOG_SITE_GROUND` emits, so its own output always fits. */
const MAX_REPORT_CHARS = 10_000;

/** One catalogue field, as a request body may carry it. */
const MAX_ENTRY_CHARS = 4_000;

/** Entries and images per entry, matching what the extraction itself keeps. */
const MAX_CATALOGUE_ENTRIES = 200;
const MAX_IMAGES = 20;

/** Raw output a caller may inline rather than pass by reference. */
const MAX_INLINE_EVIDENCE_CHARS = 40_000;

/**
 * The inline fallback's budget.
 *
 * Shorter than the dedicated pass, and deliberately: this one shares its
 * request with a generation, and the pair has to answer before the edge proxy
 * gives up. The pass writes up what it has when the time runs out, so a tighter
 * budget costs depth rather than the answer.
 */
const INLINE_GROUNDING_TIMEOUT_MS = 45_000;

export const GroundingInputSchema = z
  .object({
    report: z
      .string()
      .max(MAX_REPORT_CHARS)
      .describe("`report` from BLOG_SITE_GROUND."),
    outcome: z
      .enum(["no-site", "no-tools", "ok", "timeout", "failed"])
      .optional()
      .describe("`outcome` from the same call, so silences stay told apart."),
    evidence: z
      .string()
      .max(MAX_INLINE_EVIDENCE_CHARS)
      .optional()
      .describe("`evidence`, when that call returned it inline."),
    evidenceUri: z
      .string()
      .max(512)
      .nullable()
      .optional()
      .describe("`evidenceUri`, when it stored the raw output instead."),
  })
  .optional()
  .describe(
    "What BLOG_SITE_GROUND already found. Pass it and this call skips its own pass, which is what keeps it inside the edge proxy's window. Omit it and the pass runs inline on a tighter budget.",
  );

export type GroundingInput = z.infer<typeof GroundingInputSchema>;

/**
 * The grounding this generation runs on — supplied, or gathered now.
 *
 * `evidence` comes back empty for a supplied report that kept its raw output by
 * reference. That is deliberate: the only consumer of the raw form is the
 * catalogue pass, which has its own call and reads the reference itself. A
 * generator asking for evidence it was not given gets nothing rather than a
 * fetch it did not budget for.
 */
export async function resolveGrounding(
  ctx: StudioContext,
  organizationId: string,
  supplied: GroundingInput,
  fallback: GroundingRequest,
): Promise<GroundingReport> {
  if (supplied) {
    return {
      grounding: supplied.report,
      evidence: supplied.evidence ?? "",
      toolNames: [],
      calls: [],
      outcome: supplied.outcome ?? (supplied.report ? "ok" : "no-site"),
    };
  }
  return groundSiteReport(ctx, organizationId, {
    timeoutMs: INLINE_GROUNDING_TIMEOUT_MS,
    ...fallback,
  });
}

/**
 * The raw tool output behind a grounding, read once and taken away.
 *
 * Deleted on the way out: it is the organization's own catalogue sitting in
 * object storage for the span of one wizard, and the pass that reads it is the
 * only one that ever will. A failure to delete is not worth failing the call
 * over — the key carries its date, so an orphan is sweepable by prefix.
 */
export async function takeEvidence(
  ctx: StudioContext,
  supplied: GroundingInput,
): Promise<string> {
  if (supplied?.evidence) return supplied.evidence;
  const uri = supplied?.evidenceUri;
  if (!uri || !ctx.objectStorage) return "";
  const key = parseStudioStorageKey(uri);
  if (!key) return "";
  try {
    const bytes = await ctx.objectStorage.getBytes(key);
    const evidence = new TextDecoder().decode(bytes);
    void ctx.objectStorage
      .delete(key)
      .catch((err) =>
        console.warn("[blog] could not remove the read evidence", err),
      );
    return evidence;
  } catch (err) {
    console.warn("[blog] could not read the stored evidence", err);
    return "";
  }
}

/**
 * A catalogue the caller already extracted, as `BLOG_SITE_CATALOGUE` returns it.
 *
 * Caps here reject, and that is right: this is a request body, and a sender
 * that overruns a bound can be told so. The model-facing schemas these values
 * came from are the ones that must never reject — see `boundedText`.
 */
export const CatalogueInputSchema = z
  .object({
    products: z
      .array(
        z.object({
          id: z.string().max(MAX_ENTRY_CHARS),
          name: z.string().max(MAX_ENTRY_CHARS),
          category: z.string().max(MAX_ENTRY_CHARS),
          price: z.string().max(MAX_ENTRY_CHARS),
          slug: z.string().max(MAX_ENTRY_CHARS),
          url: z.string().max(MAX_ENTRY_CHARS),
          images: z.array(z.string().max(MAX_ENTRY_CHARS)).max(MAX_IMAGES),
          description: z.string().max(MAX_ENTRY_CHARS),
        }),
      )
      .max(MAX_CATALOGUE_ENTRIES),
    targets: z
      .array(
        z.object({
          kind: z.enum(["category", "collection"]),
          id: z.string().max(MAX_ENTRY_CHARS),
          name: z.string().max(MAX_ENTRY_CHARS),
          slug: z.string().max(MAX_ENTRY_CHARS),
          url: z.string().max(MAX_ENTRY_CHARS),
        }),
      )
      .max(MAX_CATALOGUE_ENTRIES),
  })
  .optional()
  .describe(
    "What BLOG_SITE_CATALOGUE read from the grounding's raw output. Pass it and this call skips the extraction, which is the half that does not fit alongside a generation.",
  );
