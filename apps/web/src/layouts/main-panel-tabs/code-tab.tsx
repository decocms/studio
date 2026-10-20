/**
 * CodeTab — standalone file-explorer main-panel tab (the `code` view, with the
 * open file in `?file=`).
 *
 * Unlike Preview it needs no live dev-server iframe: it talks
 * to the sandbox daemon's FS endpoints directly, so it keeps working even when
 * the dev script has crashed.
 */

import { Suspense, lazy } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useProjectContext } from "@/sdk";
import { useChatTask } from "@/components/chat/context";
import { useT } from "@/i18n/use-t.ts";
import { EmptyState } from "@/components/empty-state";

const FileExplorer = lazy(() =>
  import("@/components/sandbox/preview/file-explorer/file-explorer").then(
    (m) => ({ default: m.FileExplorer }),
  ),
);

export function CodeTab({ openPath }: { openPath: string | null }) {
  const t = useT();
  const { org } = useProjectContext();
  const { currentBranch: branch, taskId, virtualMcpId } = useChatTask();

  if (!virtualMcpId || !branch) {
    return (
      <EmptyState
        className="h-full"
        title={t("mainPanelTabs.codeTab.noSandboxToBrowse")}
        description={t("mainPanelTabs.codeTab.noSandboxToBrowseDescription")}
      />
    );
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex-1 relative overflow-hidden bg-background">
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          }
        >
          <FileExplorer
            orgSlug={org.slug}
            virtualMcpId={virtualMcpId}
            branch={branch}
            threadId={taskId ?? null}
            openPath={openPath}
          />
        </Suspense>
      </div>
    </div>
  );
}
