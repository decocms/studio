import type { TaskBoardHarnessId } from "@decocms/shared/task-board";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isCodexModel,
  supportsCodex,
} from "@decocms/shared/harness/codex-models";
import { ForbiddenError } from "@/core/access-control";
import { resolveTier, type ResolvedTier } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import type { RunClass } from "@/dispatch-queue/run-priority";
import { resolvePlanCredential } from "@/harnesses/plan-credential";

/** Reviewers select their own model independently of the implementer's runtime. */
export function taskRunHarness(
  harnessId: TaskBoardHarnessId | undefined,
  runClass?: RunClass,
): TaskBoardHarnessId {
  return runClass === "reviewer" ? "claude-code" : (harnessId ?? "claude-code");
}

export async function resolveTaskRunModel(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
  harnessId: TaskBoardHarnessId,
): Promise<ResolvedTier> {
  if (harnessId === "claude-code") return resolveTier(ctx, "smart");

  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!orgFlagEnabled(settings?.flags, "task_board_codex")) {
    throw new ForbiddenError(
      "Codex task runs require the task_board_codex organization flag.",
    );
  }
  const plan = await resolvePlanCredential(
    ctx,
    organizationId,
    userId,
    "codex",
  );
  if (plan) {
    return {
      credentialId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      modelId: CODEX_DEFAULT_MODEL,
      modelMeta: { title: CODEX_DEFAULT_MODEL, providerId: "openai" },
    };
  }
  return resolveTier(ctx, "smart", {
    acceptProvider: supportsCodex,
    acceptModel: isCodexModel,
  });
}
