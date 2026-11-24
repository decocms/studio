/**
 * Opens a business case chat: records it toward the goal when there is one,
 * seeds the case tab so it never opens blank, and creates the chat with the
 * case tab beside it. Shared by the guided intro and the store analysis's
 * losses.
 */

import {
  businessCaseMountPath,
  businessCasePath,
} from "@decocms/shared/business-case";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { formatCaseTabId } from "@/layouts/main-panel-tabs/tab-id";
import { writeCaseSeed } from "./business-case/case-seed.ts";

export interface StartBusinessCaseDeps {
  studio: {
    call: (
      name: "PLAN_GOAL_CASE_RECORD",
      input: StudioToolInput<"PLAN_GOAL_CASE_RECORD">,
    ) => Promise<unknown>;
  };
  createTaskWithMessage: (params: {
    id: string;
    tabId: string;
    message: { parts: { type: "text"; text: string }[] };
  }) => Promise<boolean>;
  storage: Parameters<typeof writeCaseSeed>[0];
}

/** Whether the chat was created; it opens either way. */
export function startBusinessCase(
  deps: StartBusinessCaseDeps,
  input: {
    goalId: string | null;
    objective: string | null;
    request: string;
    /** A sharper card title than the request; null keeps the request's. */
    title: string | null;
    /** The first message, given the case file as the agent sees it. */
    prompt: (casePath: string) => string;
  },
): Promise<boolean> {
  const threadId = crypto.randomUUID();
  const casePath = businessCasePath(threadId);
  if (input.goalId) {
    // A chat that then fails to open writes no case file, so nothing lists.
    deps.studio
      .call("PLAN_GOAL_CASE_RECORD", {
        goal_id: input.goalId,
        thread_id: threadId,
      })
      .catch(() => {});
  }
  writeCaseSeed(deps.storage, casePath, {
    objective: input.objective,
    request: input.request,
    title: input.title,
  });
  return deps.createTaskWithMessage({
    id: threadId,
    tabId: formatCaseTabId(casePath),
    message: {
      parts: [
        { type: "text", text: input.prompt(businessCaseMountPath(casePath)) },
      ],
    },
  });
}
