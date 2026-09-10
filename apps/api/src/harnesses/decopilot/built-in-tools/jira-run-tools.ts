/**
 * Jira built-ins, for a Jira-triggered run that lands on Decopilot.
 *
 * The sandbox-hosted harness reaches these over its run-scoped MCP endpoint,
 * which serves them by thread (`task-run-context.ts`). Decopilot has no such
 * endpoint — it gets built-ins — so without this a Jira run in an org with no
 * repo would be handed the TASK BOARD tools instead, and would dutifully
 * "update the task" on the hidden anchor item nobody reads while the issue
 * everybody reads went untouched.
 *
 * The thread is passed rather than read from request scope: a built-in runs
 * inside the agent loop, not inside the MCP request the endpoint version has.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import type { StudioContext } from "@/core/studio-context";
import {
  JIRA_ATTACHMENT_DOWNLOAD,
  JIRA_COMMENT_ADD,
  JIRA_ISSUE_GET,
  JIRA_ISSUE_TRANSITION,
} from "@/tools/jira/run-tools";
import { taskRunContextStore } from "@/tools/task-board/task-run-context";

/** Names kept verbatim, as the task-board built-ins are: the run's opening
 *  message tells the model to call them by these names. */
export function createJiraRunTools(
  ctx: StudioContext,
  threadId: string,
): ToolSet {
  // The tools resolve their issue from the run's thread, read from the same
  // store the MCP endpoint sets. Supplying it here is what lets one
  // implementation serve both paths.
  const inRunScope = <T>(run: () => Promise<T>): Promise<T> =>
    taskRunContextStore.run({ threadId }, run);

  return {
    JIRA_ISSUE_GET: tool({
      description: JIRA_ISSUE_GET.description,
      inputSchema: zodSchema(JIRA_ISSUE_GET.inputSchema),
      execute: (input) => inRunScope(() => JIRA_ISSUE_GET.execute(input, ctx)),
    }),
    JIRA_COMMENT_ADD: tool({
      description: JIRA_COMMENT_ADD.description,
      inputSchema: zodSchema(JIRA_COMMENT_ADD.inputSchema),
      execute: (input) =>
        inRunScope(() => JIRA_COMMENT_ADD.execute(input, ctx)),
    }),
    JIRA_ISSUE_TRANSITION: tool({
      description: JIRA_ISSUE_TRANSITION.description,
      inputSchema: zodSchema(JIRA_ISSUE_TRANSITION.inputSchema),
      execute: (input) =>
        inRunScope(() => JIRA_ISSUE_TRANSITION.execute(input, ctx)),
    }),
    JIRA_ATTACHMENT_DOWNLOAD: tool({
      description: JIRA_ATTACHMENT_DOWNLOAD.description,
      inputSchema: zodSchema(JIRA_ATTACHMENT_DOWNLOAD.inputSchema),
      execute: (input) =>
        inRunScope(() => JIRA_ATTACHMENT_DOWNLOAD.execute(input, ctx)),
    }),
  };
}
