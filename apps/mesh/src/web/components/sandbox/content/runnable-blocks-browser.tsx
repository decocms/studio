import { useState } from "react";
import {
  ChevronRight,
  Database01,
  Folder,
  SearchLg,
  Zap,
} from "@untitledui/icons";
import { toast } from "sonner";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { useSaveBlock } from "@/web/components/sections-editor/use-save-block";
import { createReferencedBlockSaver } from "@/web/components/sections-editor/save-referenced-block";
import { EmptyMessage, ItemRow } from "./content-browser";
import {
  RunnableBlockEditor,
  type RunnableTarget,
} from "./runnable-block-editor";
import {
  listAvailableRunnables,
  listSavedRunnables,
  runnableFolderPath,
  runnableGroupTitle,
  runnableSingular,
  type RunnableKind,
} from "./runnable-catalog";

type RunnableSelection =
  | { mode: "available"; resolveType: string; title: string }
  | { mode: "saved"; key: string }
  | null;

/** Virtual root folder holding the saved (global) blocks. */
const SAVED_FOLDER = "__saved__";

const KIND_ICON: Record<
  RunnableKind,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  loaders: Database01,
  actions: Zap,
};

const KIND_LABEL: Record<RunnableKind, string> = {
  loaders: "Loaders",
  actions: "Actions",
};

interface BrowsableEntry {
  resolveType: string;
  title: string;
  /** Folder path the entry lives under (derived from the resolveType). */
  folderPath: string[];
  /** Saved (global block) entries carry their decofile key. */
  savedKey?: string;
}

/** Folder segment display name: pretty group title at the root, raw below. */
function folderLabel(segment: string, depth: number): string {
  if (segment === SAVED_FOLDER) return "Saved";
  return depth === 0 ? runnableGroupTitle(segment) : segment;
}

/**
 * Folder-navigable browser for the Loaders / Actions content tabs. The main
 * panel walks the resolveType path as folders (vendor → category); leaves open
 * the {@link RunnableBlockEditor} (form + JSON + Run). Saved (global) blocks
 * live under a virtual "Saved" folder at the root. Searching flattens the tree
 * into a flat result list across every folder.
 */
export function RunnableBlocksBrowser({
  orgSlug,
  virtualMcpId,
  branch,
  previewUrl,
  meta,
  decofile,
  kind,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl: string | null;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  kind: RunnableKind;
}) {
  const [path, setPath] = useState<string[]>([]);
  const [selection, setSelection] = useState<RunnableSelection>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Reset navigation when switching between the Loaders and Actions tabs
  // (this component is reused for both).
  const [prevKind, setPrevKind] = useState(kind);
  if (prevKind !== kind) {
    setPrevKind(kind);
    setPath([]);
    setSelection(null);
    setSearchQuery("");
  }

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const saveReferencedBlock = createReferencedBlockSaver((blockKey, data) =>
    saveBlock.mutate({ blockKey, data }),
  );

  const singular = runnableSingular(kind);
  const Icon = KIND_ICON[kind];

  const entries: BrowsableEntry[] = [
    ...listSavedRunnables(meta, decofile, kind).map((e) => ({
      resolveType: e.resolveType,
      title: e.title,
      folderPath: [SAVED_FOLDER],
      savedKey: e.key,
    })),
    ...listAvailableRunnables(meta, kind).map((e) => ({
      resolveType: e.resolveType,
      title: e.title,
      folderPath: runnableFolderPath(e.resolveType),
    })),
  ];

  const q = searchQuery.trim().toLowerCase();
  const searching = q.length > 0;
  const searchResults = searching
    ? entries.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.resolveType.toLowerCase().includes(q),
      )
    : [];

  // Children of the current folder: sub-folders (with descendant counts) and
  // the entries that live directly at this level.
  const folders = new Map<string, number>();
  const items: BrowsableEntry[] = [];
  if (!searching) {
    for (const entry of entries) {
      const fp = entry.folderPath;
      if (fp.length < path.length) continue;
      if (!path.every((seg, i) => fp[i] === seg)) continue;
      if (fp.length === path.length) {
        items.push(entry);
      } else {
        const name = fp[path.length]!;
        folders.set(name, (folders.get(name) ?? 0) + 1);
      }
    }
    items.sort((a, b) => a.title.localeCompare(b.title));
  }
  const folderList = [...folders.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) =>
      folderLabel(a.name, path.length).localeCompare(
        folderLabel(b.name, path.length),
      ),
    );

  const selectEntry = (entry: BrowsableEntry) => {
    setSelection(
      entry.savedKey !== undefined
        ? { mode: "saved", key: entry.savedKey }
        : {
            mode: "available",
            resolveType: entry.resolveType,
            title: entry.title,
          },
    );
  };

  const handleCreate = async (
    blockId: string,
    data: Record<string, unknown>,
  ) => {
    await saveBlock.mutateAsync({ blockKey: blockId, data });
    toast.success(`Saved ${singular} "${blockId}"`);
    setSelection({ mode: "saved", key: blockId });
  };

  const target = buildTarget(selection, decofile);

  if (target) {
    return (
      <RunnableBlockEditor
        key={`${target.mode}:${target.mode === "saved" ? target.blockKey : target.resolveType}`}
        orgSlug={orgSlug}
        virtualMcpId={virtualMcpId}
        branch={branch}
        previewUrl={previewUrl}
        meta={meta}
        decofile={decofile}
        kind={kind}
        target={target.editorTarget}
        initialValue={target.initialValue}
        isCreating={saveBlock.isPending}
        onCreate={handleCreate}
        onSaveReferencedBlock={saveReferencedBlock}
        onBack={() => setSelection(null)}
      />
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {/* Breadcrumb + search header. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <nav
          aria-label="Folder breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
        >
          <button
            type="button"
            onClick={() => setPath([])}
            className={cn(
              "min-w-0 truncate rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground",
              path.length === 0
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {KIND_LABEL[kind]}
          </button>
          {path.map((segment, index) => {
            const isLast = index === path.length - 1;
            return (
              <span
                key={`${segment}-${index}`}
                className="flex min-w-0 items-center gap-1 overflow-hidden"
              >
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
                <button
                  type="button"
                  onClick={() => setPath(path.slice(0, index + 1))}
                  className={cn(
                    "min-w-0 truncate rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                    isLast
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {folderLabel(segment, index)}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="flex w-56 shrink-0 items-center gap-2">
          <SearchLg
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={`Search all ${kind}…`}
            aria-label={`Search all ${kind}`}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="mx-auto w-full max-w-4xl px-6 py-5">
          {searching ? (
            searchResults.length === 0 ? (
              <EmptyMessage
                title={`No ${kind} match "${searchQuery.trim()}"`}
                description="Search covers every folder — try a different term."
              />
            ) : (
              <div className="flex flex-col gap-1">
                {searchResults.map((entry) => (
                  <ItemRow
                    key={entry.savedKey ?? entry.resolveType}
                    icon={Icon}
                    accent={entry.savedKey !== undefined ? "global" : undefined}
                    title={entry.title}
                    subtitle={entry.resolveType}
                    active={false}
                    onClick={() => selectEntry(entry)}
                  />
                ))}
              </div>
            )
          ) : folderList.length === 0 && items.length === 0 ? (
            <EmptyMessage
              title={`No ${kind} here`}
              description={
                path.length === 0
                  ? "Start the preview dev server so its manifest loads."
                  : "This folder is empty."
              }
            />
          ) : (
            <>
              {folderList.length > 0 && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
                  {folderList.map((folder) => (
                    <button
                      key={folder.name}
                      type="button"
                      onClick={() => setPath([...path, folder.name])}
                      className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted cursor-pointer"
                    >
                      <Folder
                        size={18}
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {folderLabel(folder.name, path.length)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {folder.count} {folder.count === 1 ? singular : kind}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {items.length > 0 && (
                <div
                  className={cn(
                    "flex flex-col gap-1",
                    folderList.length > 0 && "mt-4",
                  )}
                >
                  {items.map((entry) => (
                    <ItemRow
                      key={entry.savedKey ?? entry.resolveType}
                      icon={Icon}
                      accent={
                        entry.savedKey !== undefined ? "global" : undefined
                      }
                      title={entry.title}
                      subtitle={entry.resolveType}
                      active={false}
                      onClick={() => selectEntry(entry)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Resolve the selected entry into the editor's target + seed props. */
function buildTarget(
  selection: RunnableSelection,
  decofile: Record<string, unknown>,
): {
  mode: RunnableTarget["mode"];
  blockKey?: string;
  resolveType: string;
  editorTarget: RunnableTarget;
  initialValue: Record<string, unknown>;
} | null {
  if (!selection) return null;

  if (selection.mode === "available") {
    return {
      mode: "available",
      resolveType: selection.resolveType,
      editorTarget: {
        mode: "available",
        resolveType: selection.resolveType,
        title: selection.title,
      },
      initialValue: {},
    };
  }

  const block = decofile[selection.key] as Record<string, unknown> | undefined;
  const resolveType =
    block && typeof block.__resolveType === "string" ? block.__resolveType : "";
  const { __resolveType: _rt, ...props } = block ?? {};
  const title =
    block && typeof block.name === "string" && block.name
      ? block.name
      : selection.key;

  return {
    mode: "saved",
    blockKey: selection.key,
    resolveType,
    editorTarget: {
      mode: "saved",
      blockKey: selection.key,
      resolveType,
      title,
    },
    initialValue: props as Record<string, unknown>,
  };
}
