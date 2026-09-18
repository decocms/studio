import type { StudioContext } from "@/core/studio-context";
import { getUserId, requireAuth } from "@/core/studio-context";
import { ForbiddenError } from "@/core/access-control";
import { getSettings } from "@/settings";

const adapted = new Set([
  "REPOSITORY_LIST",
  "TASK_BOARD_ITEM_LIST",
  "TASK_BOARD_ITEM_PRS_GET",
  "TASK_BOARD_PREVIEW_PROBE",
  "TASK_BOARD_ITEM_CREATE",
  "TASK_BOARD_ITEM_UPDATE",
  "TASK_BOARD_ITEM_DELETE",
  "TASK_BOARD_ITEM_RERUN",
  "TASK_BOARD_PROMOTE_TO_PRODUCTION",
  "TASK_BOARD_COMMENT_CREATE",
  "TASK_BOARD_COMMENT_UPDATE",
  "TASK_BOARD_COMMENT_DELETE",
]);
// Explicitly audited database-only reads. ReadOnlyHint alone does not exclude provider calls.
const localReads = new Set([
  "ORGANIZATION_LIST",
  "ORGANIZATION_GET",
  "ORGANIZATION_SETTINGS_GET",
  "ORGANIZATION_MEMBER_LIST",
  "TAGS_LIST",
  "MEMBER_TAGS_GET",
  "NOTIFICATION_LIST",
  "NOTIFICATION_SUBSCRIPTION_LIST",
  "TASK_BOARD_ACTIVITY_LIST",
  "TASK_BOARD_COMMENT_LIST",
  "TASK_BOARD_AUTOMATION_LIST",
  "TASK_BOARD_PROMPT_LIST",
  "TASK_BOARD_DISMISSED_LIST",
  "COLLECTION_THREADS_LIST",
  "COLLECTION_THREADS_GET",
  "COLLECTION_THREAD_MESSAGES_LIST",
  "AI_PROVIDER_KEY_LIST",
  "AI_PROVIDERS_LIST",
  "FILE_CONFIG_LIST",
  "COLLECTION_CONNECTIONS_LIST",
  "COLLECTION_CONNECTIONS_GET",
  "COLLECTION_VIRTUAL_MCP_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
  "VIRTUAL_MCP_LAST_USED_LIST",
  "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
  "AUTOMATION_LIST",
  "AUTOMATION_GET",
  "AUTOMATION_RUN_STATS",
  "GLOBAL_SEARCH",
  "USER_GET",
  "USER_MODEL_PREFERENCES_GET",
  "GIT_ACCOUNT_LIST",
  "TASK_BOARD_ADMIN_ORG_LIST",
  "DEMO_STATUS",
]);

export async function interceptDemoTool(
  name: string,
  input: unknown,
  ctx: StudioContext,
): Promise<{ result: unknown } | null> {
  const org = ctx.organization;
  if (!org || !ctx.storage.demo || !(await ctx.storage.demo.get(org.id)))
    return null;
  requireAuth(ctx);
  await ctx.access.check();
  if (name !== "DEMO_STATUS") ctx.storage.demo.assertConfigured(org.id);
  if (localReads.has(name)) return null;
  if (!adapted.has(name))
    throw new ForbiddenError(
      "This action is outside the prepared demonstration. Use the demonstration tasks, chats and previews.",
    );
  const actor = getUserId(ctx);
  if (!actor) throw new ForbiddenError("Sign in to use the demonstration");
  const result = await ctx.storage.demo.executeTool(
    org.id,
    actor,
    name,
    input,
    getSettings().baseUrl ?? "http://localhost:4000",
    org.slug ?? org.id,
  );
  if (result.runId) {
    const { startDemoRun } = await import("./workflow");
    await startDemoRun(org.id, result.runId);
  }
  if (
    ![
      "REPOSITORY_LIST",
      "TASK_BOARD_ITEM_LIST",
      "TASK_BOARD_ITEM_PRS_GET",
      "TASK_BOARD_PREVIEW_PROBE",
    ].includes(name)
  ) {
    const { emitDemoUpdated } = await import("./events");
    emitDemoUpdated(org.id);
  }
  return { result: result.result };
}
