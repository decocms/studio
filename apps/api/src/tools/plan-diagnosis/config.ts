import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { z } from "zod";
import type { StudioContext } from "../../core/studio-context";
import { getSettings } from "../../settings";

/** Why the diagnosis can't be used, as the Plan page reads it. */
export type PlanDiagnosisUnavailable = "flag_off" | "service_unset";

const EngineUrlSchema = z.url({ protocol: /^https?$/ });

/** The engine's MCP endpoint from PLAN_DIAGNOSIS_MCP_URL; a malformed value counts as unset. */
function resolvePlanDiagnosisMcpUrl(): string | undefined {
  const parsed = EngineUrlSchema.safeParse(getSettings().planDiagnosisMcpUrl);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The diagnosis exists only with the Plan page on. With `plan_engine_native`
 * it runs inside Studio; otherwise only where this deployment knows the
 * external engine.
 */
export async function planDiagnosisAvailability(
  ctx: StudioContext,
  organizationId: string,
): Promise<
  | { ok: true; engine: "native" }
  | { ok: true; engine: "connection"; url: string }
  | { ok: false; reason: PlanDiagnosisUnavailable }
> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) {
    return { ok: false, reason: "flag_off" };
  }
  if (orgFlagEnabled(settings?.flags, "plan_engine_native")) {
    return { ok: true, engine: "native" };
  }
  const url = resolvePlanDiagnosisMcpUrl();
  return url
    ? { ok: true, engine: "connection", url }
    : { ok: false, reason: "service_unset" };
}
