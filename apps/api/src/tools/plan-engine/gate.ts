import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { z } from "zod";
import {
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";

/**
 * The organization a Plan engine tool acts for. Refuses unless the org has
 * the Plan page and the built-in engine on.
 */
export async function engineOrg(
  ctx: StudioContext,
): Promise<{ id: string; slug: string }> {
  requireAuth(ctx);
  const org = requireOrganization(ctx);
  await ctx.access.check();
  const settings = await ctx.storage.organizationSettings.get(org.id);
  if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) {
    throw new Error(
      "flag_off: the Plan page is off for this organization (plan_page_enabled)",
    );
  }
  if (!orgFlagEnabled(settings?.flags, "plan_engine_native")) {
    throw new Error(
      "flag_off: the built-in store diagnosis is off for this organization (plan_engine_native)",
    );
  }
  return { id: org.id, slug: org.slug ?? "" };
}

export const errorOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export const RejectedSchema = z.object({
  domain: z.string(),
  reason: z.string(),
});

/** A refusal the engine answers with, as data, like its HTTP tools did. */
const ToolErrorSchema = z.object({
  error: z.string(),
  rejected: z.array(RejectedSchema).optional(),
});

/** One of the engine's rows, returned as the engine shapes it (`plan-engine/types.ts`). */
export const Row = z.custom<object>(
  (value) => typeof value === "object" && value !== null,
);

/** An engine tool's answer: its result, or its refusal as data. */
export const engineOutput = <T extends z.ZodType>(success: T) =>
  z.union([success, ToolErrorSchema]);

export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
