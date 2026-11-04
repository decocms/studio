/**
 * A brand's post formats, in a drawer over its page: one file each under
 * `formats/` (`brand-format.ts`), listed, opened to edit, created from the
 * template and deleted. A guide that still keeps its formats in a section
 * shows them read-only, with a way to move each into its own file.
 */

import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Plus,
  Stars02,
  Trash01,
} from "@untitledui/icons";
import {
  type BrandFormat,
  FORMATS_DIR,
  formatFileText,
  formatIdOf,
  MAX_FORMAT_CHARS,
  newFormatId,
  parseFormatFile,
} from "@decocms/shared/brand";
import { mentionableSections } from "@decocms/shared/blog";
import { parseFrontmatterDoc } from "@decocms/shared/harness/skill-md";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  MarkdownEditor,
  type MarkdownMentions,
} from "@/components/markdown-editor";
import { useLiveMeta } from "@/components/sections-editor/use-live-meta";
import { useHideDefaultBlogBlocks } from "@/hooks/use-hide-default-blog-blocks";
import {
  fileTextQuery,
  invalidateOrgFsWrite,
  useOrgFsFileUrl,
  useOrgFsList,
  useOrgFsMutations,
  writeOrgFsTextIf,
} from "@/hooks/use-org-fs";
import { scopableProjects } from "@/hooks/use-project-scope";
import { projectRepo } from "@/lib/repository-binding";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCPsNonBlocking } from "@/sdk";

/** A file under `formats/`, with what it reads as. */
export interface FormatFile {
  id: string;
  path: string;
  url: string;
  contentHash: string | null;
  /** Null until read, or when it could not be. */
  text: string | null;
  /** Null when the file names no format (or is not read yet). */
  format: BrandFormat | null;
}

/** Every format file of a brand, read. */
export function useBrandFormats(brandPath: string): FormatFile[] {
  const fileUrl = useOrgFsFileUrl();
  const listing = useOrgFsList(HOME_MOUNT_PATH, `${brandPath}/${FORMATS_DIR}`);
  const entries = (listing.data ?? []).flatMap((entry) => {
    const id = entry.kind === "file" ? formatIdOf(entry.path) : null;
    return id ? [{ id, entry, url: fileUrl(HOME_MOUNT_PATH, entry.path) }] : [];
  });
  const texts = useQueries({
    queries: entries.map(({ url }) => fileTextQuery(url)),
  });
  return entries.map(({ id, entry, url }, index) => {
    const text = texts[index]?.data ?? null;
    return {
      id,
      path: entry.path,
      url,
      contentHash: entry.contentHash ?? null,
      text,
      format: text === null ? null : parseFormatFile(text, id),
    };
  });
}

/** What a format file needs fixing before the agent reads it, if anything. */
function problemOf(file: FormatFile): "unnamed" | "tooLong" | null {
  if (file.text !== null && !file.format) return "unnamed";
  if (file.format && file.format.value.length > MAX_FORMAT_CHARS) {
    return "tooLong";
  }
  return null;
}

/** The blog blocks a format cites by `@`, and the site they are read from. */
interface FormatBlocks {
  sites: VirtualMCPEntity[];
  site: VirtualMCPEntity | null;
  choose: (siteId: string) => void;
  mentions: MarkdownMentions;
}

function useFormatBlocks(enabled: boolean): FormatBlocks {
  const t = useT();
  const { org } = useProjectContext();
  // Only a site with a repository has blocks to read, as the content track lists them.
  const sites = scopableProjects(useVirtualMCPsNonBlocking()).filter(
    (project) => projectRepo(project) !== null,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const site = sites.find((entry) => entry.id === chosen) ?? sites[0] ?? null;
  const hideDefaults = useHideDefaultBlogBlocks();
  // A project does not record its default branch; the app reads `main` elsewhere too.
  const meta = useLiveMeta(
    enabled && site
      ? {
          orgSlug: org.slug,
          virtualMcpId: site.id,
          branch: "main",
          threadId: null,
          previewUrl: null,
        }
      : null,
  );
  const items = meta.data
    ? mentionableSections(meta.data, { hideDefaults }).map((section) => ({
        name: section.name,
        href: section.resolveType,
        title: section.title,
        description: section.description,
      }))
    : [];
  return {
    sites,
    site,
    choose: setChosen,
    mentions: {
      items,
      hint: t("library.formats.mentionHint"),
      emptyLabel: t("library.formats.noBlocks"),
    },
  };
}

type View = { kind: "list" } | { kind: "edit"; id: string } | { kind: "new" };

export function FormatsDrawer({
  open,
  onOpenChange,
  brandPath,
  files,
  legacy,
  onFill,
  onRemoveLegacy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandPath: string;
  files: FormatFile[];
  /** Formats still kept in the guide's section. */
  legacy: BrandFormat[];
  /** Start the brand skill on the formats; `replace` rewrites the ones there, citing `site`'s blocks. */
  onFill: (replace: boolean, site: VirtualMCPEntity | null) => void;
  /** Take the formats section out of the guide; false when it changed meanwhile. */
  onRemoveLegacy: () => Promise<boolean>;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  const blocks = useFormatBlocks(open);
  const editing =
    view.kind === "edit" ? files.find((file) => file.id === view.id) : null;
  const back = () => setView({ kind: "list" });

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) back();
        onOpenChange(next);
      }}
    >
      <SheetContent
        className="w-full gap-0 sm:max-w-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {view.kind === "list" ||
        (view.kind === "edit" && (!editing || editing.text === null)) ? (
          <FormatList
            brandPath={brandPath}
            files={files}
            legacy={legacy}
            onOpen={(id) => setView({ kind: "edit", id })}
            onNew={() => setView({ kind: "new" })}
            onFill={(replace) => onFill(replace, blocks.site)}
            onRemoveLegacy={onRemoveLegacy}
          />
        ) : (
          <FormatEditor
            key={editing?.id ?? "new"}
            brandPath={brandPath}
            file={editing ?? null}
            taken={files.map((file) => file.id)}
            blocks={blocks}
            onClose={back}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** After a write under the brand: its files, listings and the blog's read of them. */
function useRefresh() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  return (url?: string) => {
    if (url)
      void queryClient.invalidateQueries({ queryKey: KEYS.fileText(url) });
    invalidateOrgFsWrite(queryClient, org.id, HOME_MOUNT_PATH);
    void queryClient.invalidateQueries({ queryKey: KEYS.blogState(org.slug) });
  };
}

function FormatList({
  brandPath,
  files,
  legacy,
  onOpen,
  onNew,
  onFill,
  onRemoveLegacy,
}: {
  brandPath: string;
  files: FormatFile[];
  legacy: BrandFormat[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onFill: (replace: boolean) => void;
  onRemoveLegacy: () => Promise<boolean>;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const refresh = useRefresh();
  const [moving, setMoving] = useState(false);

  /** Each format of the guide's section into a file of its own, then the section out. */
  const moveLegacy = async () => {
    setMoving(true);
    try {
      const taken = files.map((file) => file.id);
      const names = new Set(files.map((file) => file.format?.name));
      for (const format of legacy) {
        if (names.has(format.name)) continue;
        const id = newFormatId(format.name, taken);
        taken.push(id);
        names.add(format.name);
        const result = await writeOrgFsTextIf(
          org.slug,
          HOME_MOUNT_PATH,
          `${brandPath}/${FORMATS_DIR}/${id}.md`,
          formatFileText({ name: format.name, value: format.value }),
          { absent: true },
        );
        if (!result.ok) {
          toast.error(t("library.formats.failed"));
          return;
        }
      }
      if (!(await onRemoveLegacy())) {
        toast.error(t("library.brandPreview.brandChanged"));
        return;
      }
      toast.success(t("library.formats.moved"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.formats.failed"),
      );
    } finally {
      setMoving(false);
      refresh();
    }
  };

  return (
    <>
      <SheetHeader className="gap-1">
        <SheetTitle>{t("library.formats.title")}</SheetTitle>
        <SheetDescription>{t("library.formats.description")}</SheetDescription>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={onNew}>
            <Plus size={14} />
            {t("library.formats.new")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="secondary">
                <Stars02 size={14} />
                {t("library.formats.fill")}
                <ChevronDown size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onFill(false)}>
                {t("library.context.fillModeEmpty")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onFill(true)}>
                {t("library.context.fillModeReplace")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-6">
        {legacy.length > 0 && (
          <div className="surface-inset flex flex-col gap-2 rounded-xl px-3.5 py-3">
            <p className="text-sm font-medium text-foreground">
              {t("library.formats.legacyTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("library.formats.legacyHint")}
            </p>
            <p className="text-xs text-foreground">
              {legacy.map((format) => format.name).join(", ")}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={moving}
              onClick={() => void moveLegacy()}
            >
              {t("library.formats.moveToFiles")}
            </Button>
          </div>
        )}

        {files.length === 0 ? (
          legacy.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("library.formats.empty")}
            </p>
          )
        ) : (
          <div className="surface divide-y divide-border">
            {files.map((file) => {
              const problem = problemOf(file);
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onOpen(file.id)}
                  className="group flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-foreground">
                      {file.format?.name ?? file.id}
                    </span>
                    {file.format?.summary && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {file.format.summary}
                      </span>
                    )}
                    {problem && (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle size={12} className="shrink-0" />
                        {problem === "unnamed"
                          ? t("library.formats.unnamed")
                          : t("library.formats.tooLong", {
                              max: MAX_FORMAT_CHARS,
                            })}
                      </span>
                    )}
                  </span>
                  {file.format?.length && (
                    <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                      {file.format.length}
                    </span>
                  )}
                  <ChevronRight
                    size={14}
                    className="mt-0.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** Where an edit starts: the file's fields, or the template for a new format. */
function draftOf(file: FormatFile | null, template: string): BrandFormat {
  if (file?.format) return file.format;
  if (file?.text != null) {
    const { fm, body } = parseFrontmatterDoc(file.text);
    return {
      name: "",
      summary: fm.summary ?? "",
      length: fm.length ?? "",
      value: body.trim(),
    };
  }
  return { name: "", value: template };
}

function FormatEditor({
  brandPath,
  file,
  taken,
  blocks,
  onClose,
}: {
  brandPath: string;
  /** Null for a new format. */
  file: FormatFile | null;
  /** The ids already in use, which a new format's file must not take. */
  taken: string[];
  blocks: FormatBlocks;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const refresh = useRefresh();
  const { remove } = useOrgFsMutations(HOME_MOUNT_PATH);
  const [start] = useState(() => draftOf(file, t("library.formats.template")));
  /** The version the editor opened on: a rewrite since then is a conflict, not something to save over. */
  const [openedHash] = useState(() => file?.contentHash ?? null);
  const [name, setName] = useState(start.name);
  const [summary, setSummary] = useState(start.summary ?? "");
  const [length, setLength] = useState(start.length ?? "");
  const [brief, setBrief] = useState(start.value);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const chars = brief.trim().length;
  const tooLong = chars > MAX_FORMAT_CHARS;

  const save = async () => {
    const path =
      file?.path ??
      `${brandPath}/${FORMATS_DIR}/${newFormatId(name, taken)}.md`;
    const expect = !file
      ? { absent: true as const }
      : openedHash
        ? { contentHash: openedHash }
        : null;
    setSaving(true);
    try {
      const result = await writeOrgFsTextIf(
        org.slug,
        HOME_MOUNT_PATH,
        path,
        formatFileText({ name, summary, length, value: brief }),
        expect,
      );
      refresh(file?.url);
      if (!result.ok) {
        toast.error(
          t(
            result.reason === "conflict"
              ? "library.formats.conflict"
              : "library.formats.failed",
          ),
        );
        if (result.reason === "conflict") onClose();
        return;
      }
      toast.success(t("library.formats.saved"));
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.formats.failed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    if (!file) return;
    try {
      await remove.mutateAsync(file.path);
      refresh(file.url);
      toast.success(t("library.formats.deleted"));
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("library.formats.failed"),
      );
    }
  };

  return (
    <>
      <SheetHeader className="gap-1">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("library.formats.title")}
        </button>
        <SheetTitle>{name.trim() || t("library.formats.new")}</SheetTitle>
        <SheetDescription className="sr-only">
          {t("library.formats.description")}
        </SheetDescription>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="format-name">{t("library.formats.name")}</Label>
          <Input
            id="format-name"
            value={name}
            maxLength={120}
            placeholder={t("library.formats.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="format-summary">{t("library.formats.summary")}</Label>
          <Input
            id="format-summary"
            value={summary}
            maxLength={240}
            placeholder={t("library.formats.summaryPlaceholder")}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="format-length">{t("library.formats.length")}</Label>
          <Input
            id="format-length"
            value={length}
            maxLength={60}
            placeholder={t("library.formats.lengthPlaceholder")}
            onChange={(e) => setLength(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label>{t("library.formats.brief")}</Label>
            <span
              className={cn(
                "text-xs tabular-nums",
                tooLong ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {t("library.formats.charCount", {
                count: chars,
                max: MAX_FORMAT_CHARS,
              })}
            </span>
          </div>
          {blocks.sites.length > 1 && blocks.site && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("library.formats.blocksFrom")}</span>
              <Select value={blocks.site.id} onValueChange={blocks.choose}>
                <SelectTrigger size="sm" className="h-7 w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {blocks.sites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="rounded-xl border border-border px-3 py-2">
            <MarkdownEditor
              defaultValue={start.value}
              onChange={setBrief}
              attachments={false}
              mentions={blocks.mentions}
              placeholder={t("library.formats.briefPlaceholder")}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border px-4 py-3">
        {file && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setDeleting(true)}
          >
            <Trash01 size={14} />
            {t("library.formats.delete")}
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("library.brandPreview.cancel")}
        </Button>
        <Button
          size="sm"
          disabled={saving || name.trim() === "" || tooLong}
          onClick={() => void save()}
        >
          {t("library.brandPreview.save")}
        </Button>
      </div>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.formats.deleteTitle", {
                name: name.trim() || file?.id || "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("library.formats.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("library.brandPreview.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void destroy()}>
              {t("library.formats.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
