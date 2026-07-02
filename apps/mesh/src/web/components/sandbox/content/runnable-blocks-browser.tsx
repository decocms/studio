import { useState } from "react";
import { Database01, SearchLg, Zap } from "@untitledui/icons";
import { toast } from "sonner";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { useSaveBlock } from "@/web/components/sections-editor/use-save-block";
import { createReferencedBlockSaver } from "@/web/components/sections-editor/save-referenced-block";
import {
  EmptyMessage,
  GroupHeader,
  ItemRow,
  ListEmpty,
} from "./content-browser";
import {
  RunnableBlockEditor,
  type RunnableTarget,
} from "./runnable-block-editor";
import {
  groupRunnables,
  listAvailableRunnables,
  listSavedRunnables,
  runnableSingular,
  type RunnableKind,
} from "./runnable-catalog";

type RunnableSelection =
  | { mode: "available"; resolveType: string; title: string }
  | { mode: "saved"; key: string }
  | null;

const KIND_ICON: Record<
  RunnableKind,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  loaders: Database01,
  actions: Zap,
};

/**
 * Middle list + editor for the Loaders / Actions content tabs. Lists a site's
 * saved (global) blocks and the available (manifest) ones for the given kind;
 * selecting one opens the {@link RunnableBlockEditor} (form + JSON + Run).
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
  const [selection, setSelection] = useState<RunnableSelection>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Reset selection + search when switching between the Loaders and Actions
  // tabs (this component is reused for both).
  const [prevKind, setPrevKind] = useState(kind);
  if (prevKind !== kind) {
    setPrevKind(kind);
    setSelection(null);
    setSearchQuery("");
  }

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const saveReferencedBlock = createReferencedBlockSaver((blockKey, data) =>
    saveBlock.mutate({ blockKey, data }),
  );

  const singular = runnableSingular(kind);
  const Icon = KIND_ICON[kind];

  const saved = listSavedRunnables(meta, decofile, kind);
  const available = listAvailableRunnables(meta, kind);

  const q = searchQuery.toLowerCase();
  const filteredSaved = saved.filter(
    (e) =>
      !q ||
      e.title.toLowerCase().includes(q) ||
      e.resolveType.toLowerCase().includes(q),
  );
  const filteredAvailable = available.filter(
    (e) =>
      !q ||
      e.title.toLowerCase().includes(q) ||
      e.resolveType.toLowerCase().includes(q),
  );
  const availableGroups = groupRunnables(filteredAvailable);

  const handleCreate = async (
    blockId: string,
    data: Record<string, unknown>,
  ) => {
    await saveBlock.mutateAsync({ blockKey: blockId, data });
    toast.success(`Saved ${singular} "${blockId}"`);
    setSelection({ mode: "saved", key: blockId });
  };

  const target = buildTarget(selection, decofile);

  return (
    <div className="flex h-full w-full min-w-0">
      <div className="flex w-[300px] shrink-0 flex-col border-r min-h-0">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <div className="flex flex-1 items-center gap-2 pl-1">
            <SearchLg
              size={14}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${kind}…`}
              aria-label={`Search ${kind}`}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="flex flex-col gap-1 p-1.5">
            {filteredSaved.length === 0 && filteredAvailable.length === 0 ? (
              <ListEmpty
                hasItems={saved.length > 0 || available.length > 0}
                emptyLabel={`No ${kind} yet.`}
                emptyHint="Start the preview dev server so its manifest loads."
              />
            ) : (
              <>
                {filteredSaved.length > 0 && (
                  <>
                    <GroupHeader icon={Icon} label={`Saved ${kind}`} />
                    {filteredSaved.map((entry) => (
                      <ItemRow
                        key={entry.key}
                        icon={Icon}
                        accent="global"
                        title={entry.title}
                        subtitle={entry.resolveType}
                        active={
                          selection?.mode === "saved" &&
                          selection.key === entry.key
                        }
                        onClick={() =>
                          setSelection({ mode: "saved", key: entry.key })
                        }
                      />
                    ))}
                  </>
                )}
                {availableGroups.map((group, groupIndex) => (
                  <div key={group.key} className="flex flex-col gap-1">
                    <GroupHeader
                      icon={Icon}
                      label={`${group.title} · ${group.entries.length}`}
                      className={cn(
                        (filteredSaved.length > 0 || groupIndex > 0) && "mt-3",
                      )}
                    />
                    {group.entries.map((entry) => (
                      <ItemRow
                        key={entry.resolveType}
                        icon={Icon}
                        title={entry.title}
                        subtitle={entry.resolveType}
                        active={
                          selection?.mode === "available" &&
                          selection.resolveType === entry.resolveType
                        }
                        onClick={() =>
                          setSelection({
                            mode: "available",
                            resolveType: entry.resolveType,
                            title: entry.title,
                          })
                        }
                      />
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="min-w-0 flex-1">
        {target ? (
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
          />
        ) : (
          <EmptyMessage
            title={`Select ${kind === "loaders" ? "a loader" : "an action"} to edit`}
            description={`Pick a ${singular} to configure its input, run it against the live preview, and save it as a global block.`}
          />
        )}
      </div>
    </div>
  );
}

/** Resolve the selected list item into the editor's target + seed props. */
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
