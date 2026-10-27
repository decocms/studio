/**
 * A blog run, read while it runs.
 *
 * The same sheet Monitoring, an automation's Runs tab and a task's activity
 * feed open — so the steps of a generation are read the way every other agent
 * run on the platform is read, rather than in something invented for the blog.
 * The thread is the answer to "who edited my store, and with what".
 */

import { useQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { ThreadSheetBody } from "@/components/thread/thread-sheet-body.tsx";
import {
  SELF_MCP_ALIAS_ID,
  useConnections,
  useMCPClient,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";
import { useMembers } from "@/hooks/use-members";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { WatchedRun } from "./use-blog-run";

/** How often a run's own row is re-read while the sheet is open. The messages
 *  below poll on their own; this is the title and the status over them. */
const ROW_POLL_MS = 5_000;

/** Suspending reads behind their own boundary: hoisted, they would blank the
 *  whole tab every time a run is opened. */
function BlogRunSheetContent({
  run,
  virtualMcpId,
}: {
  run: WatchedRun;
  virtualMcpId: string;
}) {
  const { org, locator } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const connections = useConnections();
  const virtualMcps = useVirtualMCPs();
  const { data: members } = useMembers();
  const studio = useStudioTools();

  /**
   * The run's own row, re-read while it runs.
   *
   * Synthesizing it from what the start call knew leaves a sheet that says
   * "in progress" after the run has finished and has no title at all — the
   * header would be describing the moment the button was pressed rather than
   * the run it is showing.
   */
  const { data: row } = useQuery({
    queryKey: KEYS.blogRunThread(run.id),
    queryFn: () => studio.call("COLLECTION_THREADS_GET", { id: run.id }),
    refetchInterval: (query) =>
      query.state.data?.item?.status === "in_progress" ? ROW_POLL_MS : false,
  });

  return (
    <ThreadSheetBody
      thread={{
        id: run.id,
        title: row?.item?.title ?? run.title,
        status: row?.item?.status ?? "in_progress",
        created_at: row?.item?.created_at ?? new Date().toISOString(),
        virtual_mcp_id: virtualMcpId,
      }}
      client={client}
      locator={locator}
      connections={connections}
      virtualMcps={virtualMcps}
      members={members}
    />
  );
}

export function BlogRunSheet({
  run,
  virtualMcpId,
  onClose,
}: {
  run: WatchedRun | null;
  virtualMcpId: string;
  onClose: () => void;
}) {
  const t = useT();
  const title = run?.title || t("sandbox.blogRun.sheetTitle");

  return (
    <Sheet open={!!run} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        data-testid="blog-run-sheet"
        className="flex flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {run && (
          <Suspense
            fallback={
              <SheetHeader className="shrink-0 border-b border-border px-5 pb-5 pt-6 md:px-6">
                <SheetTitle className="truncate text-sm leading-snug">
                  {title}
                </SheetTitle>
              </SheetHeader>
            }
          >
            <BlogRunSheetContent run={run} virtualMcpId={virtualMcpId} />
          </Suspense>
        )}
      </SheetContent>
    </Sheet>
  );
}
