/**
 * Skill preview — a dedicated render for Claude Code skill dirs: a file
 * sidebar on the left (SKILL.md plus the bundled files) and the selected
 * file's preview on the right. SKILL.md renders as description + markdown;
 * everything else goes through the shared FilePreview viewer. URL-driven
 * (`?skill=<browse path>`), so a skill link survives reload.
 *
 * One body (`SkillPreviewContent`) feeds two shells, mirroring file previews:
 * a right-side `SkillPreviewPanel` on desktop and a near-fullscreen
 * `SkillPreviewDialog` on mobile.
 */

import { useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { X, Zap } from "@untitledui/icons";
import { MemoizedMarkdown } from "@/components/chat/markdown.tsx";
import { FilePreview } from "@/components/file-preview";
import { FileTypeIcon } from "@/components/file-type-icon";
import { useFileText, useOrgFsFileUrl, useOrgFsList } from "@/hooks/use-org-fs";
import { basename, parseLibraryPath } from "./location";
import { parseSkillMd } from "./skill";

function SkillPreviewContent({
  skillPath,
  onClose,
  variant,
}: {
  /** Browse-grammar path of the skill dir ("<volume>/<dir...>"). */
  skillPath: string;
  onClose: () => void;
  /** "dialog" uses Radix DialogTitle/DialogClose; "panel" plain elements. */
  variant: "panel" | "dialog";
}) {
  const location = parseLibraryPath(skillPath);
  const { volume, dirPath } = location;
  const fileUrl = useOrgFsFileUrl();
  const skillMdUrl = fileUrl(volume ?? "", `${dirPath}/SKILL.md`);

  const md = useFileText(skillMdUrl);
  const listing = useOrgFsList(volume ?? "", dirPath);

  const dirName = basename(dirPath);
  const meta = md.data ? parseSkillMd(md.data) : null;
  const isSkillMd = (path: string) => basename(path) === "SKILL.md";
  // SKILL.md is the entry point, so it always leads the list.
  const files = (listing.data ?? [])
    .filter((e) => e.kind === "file")
    .sort((a, b) => {
      if (isSkillMd(a.path)) return -1;
      if (isSkillMd(b.path)) return 1;
      return basename(a.path).localeCompare(basename(b.path));
    });

  // null = SKILL.md (the default view); otherwise the selected entry's path.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected =
    selectedPath === null
      ? null
      : (files.find((e) => e.path === selectedPath) ?? null);

  const titleText = meta?.name ?? dirName;

  return (
    <>
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Zap size={18} />
        </div>
        {variant === "dialog" ? (
          <DialogTitle className="flex-1 truncate text-base font-medium text-foreground">
            {titleText}
          </DialogTitle>
        ) : (
          <span className="flex-1 truncate text-base font-medium text-foreground">
            {titleText}
          </span>
        )}
        {variant === "dialog" ? (
          <DialogClose asChild>
            <Button variant="ghost" size="icon" className="size-8 shrink-0">
              <X size={16} />
            </Button>
          </DialogClose>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        )}
      </div>

      {/* Two-column body */}
      <div className="flex min-h-0 flex-1">
        {/* Left sidebar — Files */}
        <div className="flex w-[220px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-muted p-3">
          <p className="px-2 py-1.5 text-sm font-medium text-foreground">
            Files
          </p>
          {listing.isPending ? (
            <Skeleton className="mx-2 h-4 w-24" />
          ) : (
            files.map((e) => {
              const active = isSkillMd(e.path)
                ? selected === null
                : selectedPath === e.path;
              return (
                <button
                  key={e.path}
                  type="button"
                  onClick={() =>
                    setSelectedPath(isSkillMd(e.path) ? null : e.path)
                  }
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                    active ? "bg-background shadow-sm" : "hover:bg-muted/60",
                  )}
                >
                  <FileTypeIcon
                    filename={basename(e.path)}
                    className="h-6 w-5 shrink-0"
                  />
                  <span
                    className={cn(
                      "truncate text-sm",
                      active ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {basename(e.path)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Right content — selected file preview */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
          {selected ? (
            <FilePreview
              file={{
                key: selected.path,
                filename: basename(selected.path),
                size: selected.size,
                downloadUrl: fileUrl(volume ?? "", selected.path),
              }}
            />
          ) : md.isPending ? (
            <div className="flex flex-col gap-2 p-6">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ) : md.isError || !meta ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              This skill is no longer available.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-4 border-b border-border p-6">
                <p className="text-sm font-medium text-foreground">
                  Description
                </p>
                <p className="text-base text-muted-foreground">
                  {meta.description ?? "Claude Code skill"}
                </p>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none p-6">
                <MemoizedMarkdown
                  id={`skill-preview-${skillPath}`}
                  text={meta.body}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Mobile: near-fullscreen dialog. */
export function SkillPreviewDialog({
  skillPath,
  onClose,
}: {
  skillPath: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[88vh] w-[94vw] max-w-none! flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl!"
        closeButtonClassName="hidden"
      >
        <SkillPreviewContent
          skillPath={skillPath}
          onClose={onClose}
          variant="dialog"
        />
      </DialogContent>
    </Dialog>
  );
}

/** Desktop: right-side panel (consistent with file previews). */
