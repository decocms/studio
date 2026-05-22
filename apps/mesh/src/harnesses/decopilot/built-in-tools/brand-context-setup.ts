/**
 * brand_context_setup built-in tool
 *
 * Per-run injection. Only attached when the `brand-context` preset task
 * starts a thread (via DispatchRunInput.extraTools) — NOT a global tool.
 * Wraps Firecrawl extraction + brand_context row creation + signaling the
 * wrapping DBOS workflow that owns the preset card's lifecycle.
 *
 * The model is expected to call this once with the user's website URL.
 * On success the preset card flips to "completed" (the workflow handles
 * that), so the next time the user opens home the card disappears.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MeshContext } from "@/core/mesh-context";
import { extractBrandFromDomain } from "@/auth/extract-brand";
import {
  BRAND_CONTEXT_PRESET_ID,
  BRAND_EXTRACTED_TOPIC,
} from "@/preset-tasks/brand-context-workflow";
import {
  brandSnapshot,
  requireFirecrawlKey,
  requireOrgId,
} from "./brand-context-helpers";

const BrandContextSetupInputSchema = z.object({
  domain: z
    .string()
    .describe("Website URL to extract brand from (e.g. example.com)"),
});

/**
 * Constructed by the preset-tasks `/start` route and passed in via
 * `DispatchRunInput.extraTools` — does NOT take a UIMessageStreamWriter
 * because it's built outside dispatch-run (where the writer lives). The
 * latency-metadata emission other built-ins do is skipped for this reason.
 */
export function createBrandContextSetupTool(ctx: MeshContext) {
  return tool({
    description:
      "Extract brand context (colors, fonts, logos) from a website URL " +
      "and finalize the organization's brand-context onboarding. Call " +
      "this exactly once, with the URL the user provides. The brand " +
      "context becomes the organization's default after this completes.",
    inputSchema: zodSchema(BrandContextSetupInputSchema),
    execute: async (input) => {
      const orgRes = requireOrgId(ctx);
      if (typeof orgRes !== "string") return orgRes;
      const keyRes = requireFirecrawlKey(ctx);
      if (typeof keyRes !== "string") return keyRes;

      const extracted = await extractBrandFromDomain(
        input.domain,
        keyRes,
        input.domain,
      );
      if (!extracted) {
        return {
          success: false,
          error: "Firecrawl did not return branding data for this URL.",
        };
      }

      const created = await ctx.storage.brandContext.create(
        orgRes,
        brandSnapshot(extracted),
      );

      // Best-effort: signal the wrapping DBOS preset workflow. Brand is
      // already persisted, so a failed send isn't user-visible — the
      // preset card just won't auto-dismiss until the next refresh (the
      // isApplicable check skips orgs with any brand_context row).
      const presetState = await ctx.storage.presetTasks.get(
        orgRes,
        BRAND_CONTEXT_PRESET_ID,
      );
      if (presetState?.dbosWorkflowId) {
        try {
          await DBOS.send(
            presetState.dbosWorkflowId,
            { brandId: created.id },
            BRAND_EXTRACTED_TOPIC,
          );
        } catch (err) {
          console.warn(
            `[brand_context_setup] DBOS.send to ${presetState.dbosWorkflowId} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      return {
        success: true,
        name: created.name,
        domain: created.domain,
        overview: created.overview,
        logo: created.logo,
        favicon: created.favicon,
        ogImage: created.ogImage,
        colors: created.colors,
        fonts: created.fonts,
      };
    },
  });
}
