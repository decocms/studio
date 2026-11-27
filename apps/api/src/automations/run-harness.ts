/**
 * Which harness an automation run uses.
 *
 * A run takes the deployment's sandbox harness (`claude-code`), or Decopilot
 * where the deployment has no hosted sandboxes. An automation may choose
 * Decopilot instead, behind the org's `automation_harness_decopilot` flag: a
 * run that only calls a few MCP tools then skips the pod and the Claude Code
 * setup, and its model, tool list and step limit apply.
 *
 * The choice needs a tool list without file tools. Decopilot's file tools
 * start a sandbox on their first call, and only an allowlist keeps them out
 * of the run.
 */

import { z } from "zod";
import {
  type OrgFlags,
  orgFlagEnabled,
} from "@decocms/shared/organization/schema";
import type { HostedHarnessId } from "@/api/routes/decopilot/dispatch-run";
import type { StudioContext } from "@/core/studio-context";
import type { createVmTools } from "@/harnesses/lib/decopilot/built-in-tools/vm-tools";
import type { Automation } from "@/storage/types";
import { parseToolAllowlist } from "./build-stream-request";

export const AUTOMATION_HARNESS_FLAG =
  "automation_harness_decopilot" satisfies keyof OrgFlags;

/** The harnesses an automation may choose; null keeps the default. */
export const AutomationHarnessIdSchema = z.enum(["decopilot"]);
export type AutomationHarnessId = z.infer<typeof AutomationHarnessIdSchema>;

/** The stored column, read as a choice; anything else keeps the default. */
export function parseAutomationHarnessId(
  value: unknown,
): AutomationHarnessId | null {
  const parsed = AutomationHarnessIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Keyed by Decopilot's VM tool set, so a new file tool fails to compile here.
const FILE_TOOLS: Record<keyof ReturnType<typeof createVmTools>, true> = {
  read: true,
  write: true,
  edit: true,
  grep: true,
  glob: true,
  bash: true,
  skill: true,
};

function fileToolsIn(tools: readonly string[]): string[] {
  return tools.filter((name) => Object.hasOwn(FILE_TOOLS, name));
}

function hasAllowlist(tools: readonly string[] | null): tools is string[] {
  return !!tools && tools.length > 0;
}

export function automationRunHarness(input: {
  chosen: AutomationHarnessId | null;
  toolAllowlist: readonly string[] | null;
  sandboxAvailable: boolean;
  flagEnabled: boolean;
}): HostedHarnessId {
  if (!input.sandboxAvailable) return "decopilot";
  if (
    input.chosen === "decopilot" &&
    input.flagEnabled &&
    hasAllowlist(input.toolAllowlist) &&
    fileToolsIn(input.toolAllowlist).length === 0
  ) {
    return "decopilot";
  }
  return "claude-code";
}

/**
 * The harness a fire runs on. An automation that chose none never builds the
 * context, so the default path reads nothing more than it did before.
 */
export async function resolveAutomationRunHarness(
  automation: Pick<Automation, "organization_id" | "harness_id" | "tools">,
  opts: {
    sandboxAvailable: boolean;
    context: () => Promise<StudioContext | null>;
  },
): Promise<HostedHarnessId> {
  const toolAllowlist = parseToolAllowlist(automation.tools);
  if (!automation.harness_id || !opts.sandboxAvailable) {
    return automationRunHarness({
      chosen: null,
      toolAllowlist,
      sandboxAvailable: opts.sandboxAvailable,
      flagEnabled: false,
    });
  }
  const ctx = await opts.context();
  return automationRunHarness({
    chosen: automation.harness_id,
    toolAllowlist,
    sandboxAvailable: true,
    flagEnabled: ctx
      ? await automationHarnessFlagEnabled(ctx, automation.organization_id)
      : false,
  });
}

export async function automationHarnessFlagEnabled(
  ctx: StudioContext,
  organizationId: string,
): Promise<boolean> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  return orgFlagEnabled(settings?.flags, AUTOMATION_HARNESS_FLAG);
}

/** Why an automation may not be saved with this choice, or null. */
export function automationHarnessError(input: {
  chosen: AutomationHarnessId | null;
  toolAllowlist: readonly string[] | null;
  flagEnabled: boolean;
}): string | null {
  if (input.chosen === null) return null;
  if (!input.flagEnabled) {
    return `Running automations without a sandbox is off for this organization (${AUTOMATION_HARNESS_FLAG}).`;
  }
  if (!hasAllowlist(input.toolAllowlist)) {
    return "An automation that runs without a sandbox needs a list of tools.";
  }
  const fileTools = fileToolsIn(input.toolAllowlist);
  if (fileTools.length > 0) {
    return `An automation that runs without a sandbox cannot use file tools: ${fileTools.join(", ")}.`;
  }
  return null;
}
