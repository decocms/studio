import { useTaskBoardItemPrs } from "@/hooks/use-task-board-item-prs";
import { UrlPreview } from "@/components/sandbox/preview/url-preview";
import { taskPreviewUrl } from "./task-preview-url";
import type { TaskBoardItem } from "./config";

export function TaskPreview({ item }: { item: TaskBoardItem }) {
  const { data: prs = [] } = useTaskBoardItemPrs(item.id);
  const url = taskPreviewUrl(item.description, prs);
  return url ? <UrlPreview key={`${item.id}:${url}`} url={url} /> : null;
}
