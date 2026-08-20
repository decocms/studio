/**
 * CodeTab — standalone file-explorer main-panel tab (`?main=code` /
 * `?main=code:<encoded path>`).
 *
 * Unlike Preview it needs no live dev-server iframe: it talks
 * to the sandbox daemon's FS endpoints directly, so it keeps working even when
 * the dev script has crashed. Renders the IDE (VSCode/Cursor) affordances when
 * a user-desktop sandbox exposes a local repo directory.
 */

import { Suspense, lazy } from "react";
import { Loading01 } from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { useInsetContext } from "@/layouts/agent-shell-layout";
import { useChatTask } from "@/components/chat/context";
import { useSandboxLifecycle } from "@/components/sandbox/hooks/sandbox-lifecycle-context";
import { useSandboxRepoDir } from "@/components/sandbox/hooks/use-sandbox-repo-dir";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { ideDeepLink } from "@/components/sandbox/ide-deep-link";
import { useT } from "@/i18n/use-t.ts";

const VSCODE_ICON_URL =
  "https://decoims.com/decocms/01b321bd-4613-4b2c-9348-35058444d210/Visual_Studio_Code_1.35_icon.svg.png";
const CURSOR_ICON_URL =
  "https://decoims.com/decocms/7583d3b5-81d0-4afb-becf-6a59bbb3a68e/cursor-logo-icon-freelogovectors.net_.png";

const FileExplorer = lazy(() =>
  import("@/components/sandbox/preview/file-explorer/file-explorer").then(
    (m) => ({ default: m.FileExplorer }),
  ),
);

export function CodeTab({ openPath }: { openPath: string | null }) {
  const t = useT();
  const inset = useInsetContext();
  const { org } = useProjectContext();
  const { currentBranch: branch, taskId } = useChatTask();
  const virtualMcpId = inset?.entity?.id ?? null;

  const lifecycle = useSandboxLifecycle();
  const vmEvents = useSandboxEvents();
  const vmEntry = lifecycle.vmEntry;
  const devServerReady = vmEvents.lifecycle.phase === "running";

  const isDesktopSandbox = vmEntry?.sandboxProviderKind === "user-desktop";
  const rawRepoDir = useSandboxRepoDir({
    orgSlug: org.slug,
    virtualMcpId: virtualMcpId ?? "",
    branch: branch ?? "",
    threadId: taskId ?? null,
    enabled: isDesktopSandbox && devServerReady && !!virtualMcpId && !!branch,
  });
  const repoDir = isDesktopSandbox ? rawRepoDir : null;

  if (!virtualMcpId || !branch) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {t("mainPanelTabs.codeTab.noSandboxToBrowse")}
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full">
      {repoDir && (
        <div className="relative flex h-12 shrink-0 items-center border-b border-border/60 px-3 md:px-4">
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("mainPanelTabs.codeTab.openInVscode")}
                  onClick={() => window.open(ideDeepLink("vscode", repoDir))}
                >
                  <img
                    src={VSCODE_ICON_URL}
                    alt="VSCode"
                    width={14}
                    height={14}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("mainPanelTabs.codeTab.openInVscode")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("mainPanelTabs.codeTab.openInCursor")}
                  onClick={() => window.open(ideDeepLink("cursor", repoDir))}
                >
                  <img
                    src={CURSOR_ICON_URL}
                    alt="Cursor"
                    width={14}
                    height={14}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("mainPanelTabs.codeTab.openInCursor")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}
      <div className="flex-1 relative overflow-hidden bg-background">
        <Suspense
          fallback={
            <div className="h-full flex items-center justify-center">
              <Loading01
                size={20}
                className="animate-spin text-muted-foreground"
              />
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
