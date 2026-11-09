import type { PreviewDeviceSize } from "@/components/sandbox/preview/device-hint";
import { useT } from "@/i18n/use-t";
import { useTaskBoardItemPrs } from "@/hooks/use-task-board-item-prs";
import { UrlPreview } from "@/components/sandbox/preview/url-preview";
import { taskPreviewUrl } from "./task-preview-url";
import type { TaskBoardItem } from "./config";

export function TaskPreview({
  item,
  initialDevice,
  showEmptyState = false,
}: {
  item: TaskBoardItem;
  initialDevice?: PreviewDeviceSize;
  showEmptyState?: boolean;
}) {
  const t = useT();
  const { data: prs = [] } = useTaskBoardItemPrs(item.id);
  const url = taskPreviewUrl(item.description, prs);
  return url ? (
    <UrlPreview
      key={`${item.id}:${url}`}
      url={url}
      initialDevice={initialDevice}
    />
  ) : showEmptyState ? (
    <p className="p-6 text-sm text-muted-foreground">
      {t("voiceInbox.previewNotReported")}
    </p>
  ) : null;
}
