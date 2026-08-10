/**
 * Files and skills section for the agent (Virtual MCP) settings page.
 *
 * Lets the user attach files and skills to the agent as reference knowledge.
 * Everything lives in the org filesystem (the Library): uploads land in the
 * `home` volume under `knowledge/` (shared, persistent, and mounted into every
 * agent sandbox), and skills are the Claude Code skill folders (dirs with a
 * SKILL.md) the org already has. The selection is recorded on
 * `metadata.knowledge`; at system-prompt build time the agent gets a
 * `<knowledge>` block that lists each item with the exact sandbox path to read
 * it, inlining small text documents in full.
 *
 * The add affordance mirrors the connections section: a button opens a small
 * dropdown to upload a new file, pick a recent Library file, or pick a skill.
 */

import type { KnowledgeFile } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Folder,
  Paperclip,
  Plus,
  SearchMd,
  Stars01,
  Trash01,
} from "@untitledui/icons";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import {
  type OrgFsRecentEntry,
  type OrgFsSkill,
  useOrgFsFileUrl,
  useOrgFsMutations,
  useOrgFsRecent,
  useOrgFsSkills,
} from "@/hooks/use-org-fs.ts";
import type { VirtualMcpFormReturn } from "./types";

/** Max bytes per attached file. Keeps a single doc from dominating storage. */
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * Volume + folder agent knowledge uploads land in. The `home` volume is the
 * org's shared, persistent space, mounted into every agent's sandbox and shown
 * in the Library, so attached files are both visible to the agent and
 * browsable by the team. (The `uploads` volume is per-thread chat attachments,
 * the wrong place for durable agent knowledge.)
 */
const KNOWLEDGE_VOLUME = "home";
const KNOWLEDGE_DIR = "knowledge";

function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Last path segment — the display name for a file. */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function FilesSection({ form }: { form: VirtualMcpFormReturn }) {
  const t = useT();
  const { upload } = useOrgFsMutations(KNOWLEDGE_VOLUME);
  const fileUrl = useOrgFsFileUrl();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  // Lazily loaded on first picker open, then cached + invalidated on upload.
  const { data: recent = [] } = useOrgFsRecent(60, { enabled: pickerOpen });
  const { data: skills = [] } = useOrgFsSkills({ enabled: pickerOpen });

  // Local optimistic state owns the UI source of truth, decoupled from the
  // form-watch subscription and autosave invalidation (same pattern as the
  // sub-agents section). form.setValue persists in the background.
  const [files, setFiles] = useState<KnowledgeFile[]>(
    () => form.getValues("metadata.knowledge") ?? [],
  );

  const persist = (next: KnowledgeFile[]) => {
    setFiles(next);
    form.setValue("metadata.knowledge", next, { shouldDirty: true });
  };

  const handleUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const all = Array.from(fileList);
    const toUpload = all.filter((file) => file.size <= MAX_FILE_BYTES);
    const rejected = all.filter((file) => file.size > MAX_FILE_BYTES);
    if (rejected.length > 0) {
      toast.warning(t("virtualMcp.filesSection.fileTooLargeTitle"), {
        description: t("virtualMcp.filesSection.fileTooLargeDescription", {
          names: rejected.map((file) => file.name).join(", "),
        }),
      });
    }
    if (toUpload.length === 0) return;
    try {
      await upload.mutateAsync({ dir: KNOWLEDGE_DIR, files: toUpload });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("virtualMcp.filesSection.failedUploadFile"),
      );
      return;
    }
    persist([
      ...files,
      ...toUpload.map(
        (file): KnowledgeFile => ({
          id: crypto.randomUUID(),
          name: file.name,
          volume: KNOWLEDGE_VOLUME,
          path: `${KNOWLEDGE_DIR}/${file.name}`,
          url: fileUrl(KNOWLEDGE_VOLUME, `${KNOWLEDGE_DIR}/${file.name}`),
          contentType: file.type || null,
          size: file.size,
          addedAt: new Date().toISOString(),
        }),
      ),
    ]);
  };

  const handleAttachExisting = (rf: OrgFsRecentEntry) => {
    if (files.some((f) => f.volume === rf.volume && f.path === rf.path)) return;
    persist([
      ...files,
      {
        id: crypto.randomUUID(),
        name: basename(rf.path),
        volume: rf.volume,
        path: rf.path,
        url: fileUrl(rf.volume, rf.path),
        contentType: null,
        size: rf.size ?? null,
        addedAt: new Date().toISOString(),
      },
    ]);
    setPickerOpen(false);
  };

  const handleAttachSkill = (skill: OrgFsSkill) => {
    if (files.some((f) => f.volume === skill.volume && f.path === skill.path)) {
      return;
    }
    persist([
      ...files,
      {
        id: crypto.randomUUID(),
        name: basename(skill.path),
        kind: "skill",
        volume: skill.volume,
        path: skill.path,
        url: fileUrl(skill.volume, skill.path),
        contentType: null,
        size: null,
        addedAt: new Date().toISOString(),
      },
    ]);
    setPickerOpen(false);
  };

  const handleRemove = (id: string) => {
    persist(files.filter((f) => f.id !== id));
  };

  const onPickerOpenChange = (open: boolean) => {
    setPickerOpen(open);
    if (open) setSearch("");
  };

  const attachedKeys = new Set(files.map((f) => `${f.volume}/${f.path}`));
  const lower = search.toLowerCase();
  // The last 5 Library files, filtered by the search query.
  const filteredRecent = recent
    .filter((o) => o.kind !== "dir")
    .filter((o) => !attachedKeys.has(`${o.volume}/${o.path}`))
    .filter((o) => basename(o.path).toLowerCase().includes(lower))
    .slice(0, 5);
  const filteredSkills = skills
    .filter((o) => !attachedKeys.has(`${o.volume}/${o.path}`))
    .filter((o) => basename(o.path).toLowerCase().includes(lower))
    .slice(0, 5);

  const renderPicker = (trigger: ReactNode) => (
    <DropdownMenu open={pickerOpen} onOpenChange={onPickerOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          onSelect={() => {
            inputRef.current?.click();
          }}
        >
          <Paperclip size={16} />
          {t("virtualMcp.filesSection.uploadFile")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
            <Folder size={16} />
            {t("virtualMcp.filesSection.selectFileOrFolder")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72 p-0">
            <div className="flex items-center gap-2 border-b px-3">
              <SearchMd size={16} className="shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={t(
                  "virtualMcp.filesSection.searchFilesPlaceholder",
                )}
                className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filteredRecent.length === 0 ? (
                <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                  {t("virtualMcp.filesSection.noFilesFound")}
                </p>
              ) : (
                filteredRecent.map((obj) => (
                  <DropdownMenuItem
                    key={`${obj.volume}/${obj.path}`}
                    onSelect={() => handleAttachExisting(obj)}
                  >
                    <FileTypeIcon
                      filename={basename(obj.path)}
                      className="h-5 w-4 shrink-0"
                    />
                    <span className="flex-1 truncate">
                      {basename(obj.path)}
                    </span>
                    {obj.size != null && (
                      <span className="text-xs text-muted-foreground">
                        {formatSize(obj.size)}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
            <Stars01 size={16} />
            {t("virtualMcp.filesSection.selectSkill")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72 p-0">
            <div className="flex items-center gap-2 border-b px-3">
              <SearchMd size={16} className="shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={t(
                  "virtualMcp.filesSection.searchSkillsPlaceholder",
                )}
                className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filteredSkills.length === 0 ? (
                <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                  {t("virtualMcp.filesSection.noSkillsFound")}
                </p>
              ) : (
                filteredSkills.map((skill) => (
                  <DropdownMenuItem
                    key={`${skill.volume}/${skill.path}`}
                    onSelect={() => handleAttachSkill(skill)}
                  >
                    <Stars01 size={16} className="shrink-0" />
                    <span className="flex-1 truncate">
                      {basename(skill.path)}
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium text-foreground">
            {t("virtualMcp.filesSection.filesAndSkills")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("virtualMcp.filesSection.description")}
          </p>
        </div>
        {files.length > 0 &&
          renderPicker(
            <Button variant="outline" size="sm" disabled={upload.isPending}>
              {upload.isPending ? <Spinner size="xs" /> : <Plus size={14} />}
              {t("virtualMcp.filesSection.add")}
            </Button>,
          )}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleUpload(e.target.files);
          e.target.value = "";
        }}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          // Stop the drop from bubbling to the chat composer's window-level
          // drop listener (input.tsx `useWindowFileDrop`), which would
          // otherwise upload the same file into the chat input too.
          e.stopPropagation();
          setIsDragging(false);
          void handleUpload(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col gap-2 rounded-lg",
          isDragging && "outline outline-2 outline-dashed outline-primary",
        )}
      >
        {files.length === 0
          ? renderPicker(
              <button
                type="button"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-dashed border-border hover:bg-accent/50 transition-colors w-full text-left cursor-pointer"
              >
                <div className="flex items-center justify-center size-8 rounded-md text-muted-foreground/75 border border-dashed border-border shrink-0">
                  <Plus size={16} />
                </div>
                <span className="text-sm text-muted-foreground flex-1">
                  {t("virtualMcp.filesSection.noFilesOrSkillsYet")}
                </span>
              </button>,
            )
          : files.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-card"
              >
                {file.kind === "skill" ? (
                  <div className="flex items-center justify-center h-8 w-6.5 shrink-0 rounded-md bg-muted text-muted-foreground">
                    <Stars01 size={16} />
                  </div>
                ) : (
                  <FileTypeIcon
                    filename={file.name}
                    className="h-8 w-6.5 shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {file.kind === "skill"
                      ? t("virtualMcp.filesSection.kindSkill")
                      : file.size != null
                        ? formatSize(file.size)
                        : t("virtualMcp.filesSection.kindFile")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemove(file.id)}
                  aria-label={t("virtualMcp.filesSection.removeAriaLabel", {
                    name: file.name,
                  })}
                >
                  <Trash01 size={16} />
                </Button>
              </div>
            ))}
      </div>
    </section>
  );
}
