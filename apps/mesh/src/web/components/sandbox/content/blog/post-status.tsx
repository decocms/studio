import { Badge } from "@deco/ui/components/badge.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  POST_STATUS_LABELS,
  POST_STATUSES,
  type PostStatus,
  postStatusOf,
} from "./blog-data";

/**
 * Status → dot color. We keep the badge itself as the neutral `outline`
 * variant (portable across the design system) and carry the semantic color on
 * a small dot, so an unknown/legacy status still renders sensibly.
 */
const STATUS_DOT: Record<PostStatus, string> = {
  published: "bg-emerald-500",
  draft: "bg-amber-500",
  awaiting_review: "bg-sky-500",
  generating: "bg-sky-500",
  archived: "bg-muted-foreground",
};

function labelFor(status: string): string {
  return POST_STATUS_LABELS[status as PostStatus] ?? status;
}

/** Small status pill used in the posts list and the editor header. */
export function PostStatusBadge({ status }: { status: string }) {
  const dot = STATUS_DOT[status as PostStatus] ?? "bg-muted-foreground";
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {labelFor(status)}
    </Badge>
  );
}

/**
 * Status selector for the post editor. Reads the current status off the post
 * payload (legacy posts → `published`) and writes the chosen value back onto
 * `post.status`.
 */
export function PostStatusSelect({
  post,
  onChange,
}: {
  post: Record<string, unknown>;
  onChange: (value: PostStatus) => void;
}) {
  const current = postStatusOf(post);
  return (
    <div className="space-y-2">
      <Label htmlFor="post-status">Status</Label>
      <Select
        value={current}
        onValueChange={(value) => onChange(value as PostStatus)}
      >
        <SelectTrigger id="post-status" className="h-10">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {POST_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    STATUS_DOT[status],
                  )}
                />
                {POST_STATUS_LABELS[status]}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Only <span className="font-medium">Published</span> posts appear on the
        live site. Legacy posts with no status stay published.
      </p>
    </div>
  );
}
