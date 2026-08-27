/**
 * A task's linked agent run, read inline.
 *
 * Clicking a run on a task used to navigate into its chat, which meant leaving
 * the task to read what the agent did on it. This is the same sheet Monitoring
 * and an automation's Runs tab use, minus their list navigation: a task's runs
 * are read one at a time, from the activity feed that lists them.
 */

import { Suspense } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import {
  ThreadSheetBody,
  type ThreadSheetThread,
} from "@/components/thread/thread-sheet-body.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";
import { useMembers } from "@/hooks/use-members";
import { useT } from "@/i18n/use-t.ts";
import type { TaskBoardItemThread } from "./config";

/** A task's run carries fewer fields than a monitoring row; the sheet's own
 *  type is the loose one, so this is a straight widening. */
function toSheetThread(thread: TaskBoardItemThread): ThreadSheetThread {
  return {
    id: thread.threadId,
    title: thread.title,
    status: thread.status,
    created_at: thread.createdAt,
    virtual_mcp_id: thread.virtualMcpId,
  };
}

function TaskThreadSheetLoading({ title }: { title: string }) {
  return (
    <>
      <SheetHeader className="shrink-0 border-b border-border px-5 pb-5 pt-6 md:px-6">
        <SheetTitle className="truncate text-sm leading-snug">
          {title}
        </SheetTitle>
      </SheetHeader>
      <div className="flex flex-1 items-center justify-center" />
    </>
  );
}

/** Suspending reads, behind their own boundary: hoisted into the editor they would blank the whole task on every open. */
function TaskThreadSheetContent({ thread }: { thread: TaskBoardItemThread }) {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const connections = useConnections();
  const virtualMcps = useVirtualMCPs();
  const { data: members } = useMembers();

  return (
    <ThreadSheetBody
      thread={toSheetThread(thread)}
      client={client}
      locator={locator}
      connections={connections}
      virtualMcps={virtualMcps}
      members={members}
      meta={false}
    />
  );
}

export function TaskThreadSheet({
  thread,
  onClose,
}: {
  /** The run being read, or null when the sheet is closed. */
  thread: TaskBoardItemThread | null;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <Sheet open={!!thread} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        data-testid="task-thread-sheet"
        className="flex flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {thread && (
          <Suspense
            fallback={
              <TaskThreadSheetLoading
                title={
                  thread.title ??
                  t("taskBoard.taskDialog.superAgentDefaultName")
                }
              />
            }
          >
            <TaskThreadSheetContent thread={thread} />
          </Suspense>
        )}
      </SheetContent>
    </Sheet>
  );
}
