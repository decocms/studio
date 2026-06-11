/**
 * Skill preview — a dedicated dialog for Claude Code skill dirs
 * (`?skill=<browse path>`): frontmatter name/description as the header,
 * the SKILL.md body rendered as markdown, and the bundled files listed
 * below with click-through to the regular file preview. URL-driven, so a
 * skill link survives reload.
 */

import { useQuery } from "@tanstack/react-query";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Folder, Zap } from "@untitledui/icons";
import { MemoizedMarkdown } from "@/web/components/chat/markdown.tsx";
import { formatSize } from "@/web/components/file-preview";
import { FileTypeIcon } from "@/web/components/file-type-icon";
import { useOrgFsFileUrl, useOrgFsList } from "@/web/hooks/use-org-fs";
import { KEYS } from "@/web/lib/query-keys";
import { basename, browsePathFor, parseLibraryPath } from "./location";
import { parseSkillMd } from "./skill";

export function SkillPreviewDialog({
  skillPath,
  onClose,
  onOpenFile,
  onBrowse,
}: {
  /** Browse-grammar path of the skill dir ("<volume>/<dir...>"). */
  skillPath: string;
  onClose: () => void;
  /** Open a bundled file in the regular file preview. */
  onOpenFile: (previewPath: string) => void;
  /** Navigate the Library to the underlying folder. */
  onBrowse: (browsePath: string) => void;
}) {
  const location = parseLibraryPath(skillPath);
  const { volume, dirPath } = location;
  const fileUrl = useOrgFsFileUrl();
  const skillMdUrl = fileUrl(volume ?? "", `${dirPath}/SKILL.md`);

  const md = useQuery({
    queryKey: KEYS.fileText(skillMdUrl),
    queryFn: async () => {
      const res = await fetch(skillMdUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      return res.text();
    },
    staleTime: 60_000,
    retry: false,
  });
  const listing = useOrgFsList(volume ?? "", dirPath);

  const dirName = basename(dirPath);
  const meta = md.data ? parseSkillMd(md.data) : null;
  const bundled = (listing.data ?? []).filter(
    (e) => e.kind === "file" && basename(e.path) !== "SKILL.md",
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex h-[85vh] w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl!">
        <div className="flex shrink-0 items-start gap-3 border-b border-border/60 py-4 pr-12 pl-5">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Zap size={20} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <DialogTitle className="truncate text-sm font-medium text-foreground">
              {meta?.name ?? dirName}
            </DialogTitle>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {meta?.description ?? "Claude Code skill"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => onBrowse(skillPath)}
          >
            <Folder size={14} />
            Browse files
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {md.isPending ? (
            <div className="flex flex-col gap-2 p-6">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : md.isError || !meta ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              This skill is no longer available.
            </div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none px-6 py-5">
              <MemoizedMarkdown
                id={`skill-preview-${skillPath}`}
                text={meta.body}
              />
            </div>
          )}
        </div>

        {bundled.length > 0 && (
          <div className="flex max-h-44 shrink-0 flex-col gap-1 overflow-y-auto border-t border-border/60 px-3 py-2.5">
            <p className="px-2 text-xs text-muted-foreground">
              Files in this skill
            </p>
            {bundled.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => onOpenFile(browsePathFor(location, e.path))}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60"
              >
                <FileTypeIcon
                  filename={basename(e.path)}
                  className="h-5 w-4 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {basename(e.path)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatSize(e.size)}
                </span>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
