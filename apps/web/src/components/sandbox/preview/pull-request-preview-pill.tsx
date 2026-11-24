import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useChatTask } from "@/components/chat/context";
import type { PrDraftPreview } from "@/hooks/use-pr-draft-preview";
import { useT } from "@/i18n/use-t";
import { track } from "@/lib/posthog-client";

/**
 * Over a pull request draft whose deploy preview is not up: the draft renders
 * on the published code meanwhile. When the preview failed or there is none,
 * a coding session on the branch is the way to see the pull request's code.
 */
export function PullRequestPreviewPill({
  preview,
}: {
  preview: PrDraftPreview;
}) {
  const t = useT();
  const { currentBranch: branch, createTask } = useChatTask();
  if (preview.state === "ready") return null;
  const waiting = preview.state === "pending" || preview.state === "building";
  const openCodingSession =
    branch && createTask
      ? () => {
          const id = createTask({ runtime: "sandbox", branch });
          track("coding_session_started", { thread_id: id });
        }
      : undefined;
  return (
    <div className="absolute top-4 left-1/2 z-20 flex max-w-md -translate-x-1/2 items-start gap-3 rounded-xl bg-muted px-4 py-3 shadow-soft select-none">
      {waiting && (
        <Spinner className="size-4.5 mt-0.5 shrink-0 text-muted-foreground" />
      )}
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">
          {waiting
            ? t("sandbox.preview.pullRequestPreviewBuilding")
            : preview.state === "failed"
              ? t("sandbox.preview.pullRequestPreviewFailed")
              : t("sandbox.preview.pullRequestPreviewNone")}
        </span>
        <span className="text-xs text-muted-foreground">
          {waiting
            ? t("sandbox.preview.pullRequestPreviewBuildingHint")
            : t("sandbox.preview.pullRequestPreviewMissingHint")}
        </span>
        {!waiting && (
          <div className="mt-2 flex gap-2">
            {openCodingSession && (
              <Button size="sm" onClick={openCodingSession}>
                {t("sandbox.preview.openInCodeMode")}
              </Button>
            )}
            {preview.state === "failed" && preview.htmlUrl && (
              <Button size="sm" variant="outline" asChild>
                <a href={preview.htmlUrl} target="_blank" rel="noreferrer">
                  {t("sandbox.preview.viewPullRequest")}
                </a>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
