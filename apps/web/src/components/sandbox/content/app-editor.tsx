import { useOptionalChatTask } from "@/components/chat/chat-context";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ChevronRight } from "@untitledui/icons";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { AddSectionModal } from "@/components/sections-editor/add-section-modal";
import { useSectionPreviewBase } from "@/components/sections-editor/use-section-preview-base";
import { appLabel } from "@/components/sections-editor/page-list";
import {
  hasManifestBlockSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import type { SectionCatalogEntry } from "@/components/sections-editor/section-catalog";
import { createReferencedBlockSaver } from "@/components/sections-editor/save-referenced-block";
import {
  keptTheirVersion,
  type SaveGuard,
  useDebouncedSaveBlock,
  useSaveBlock,
} from "@/components/sections-editor/use-save-block";
import {
  hasEditableAppEditorSchema,
  resolveAppEditorSchema,
} from "./app-editor-schema";
import { buildSectionBlockFromCatalogEntry } from "./section-create";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import {
  breadcrumbsForHeaderClick,
  type Crumb,
  crumbLabel,
} from "@/components/sections-editor/schema-form-breadcrumb";
import { SaveStatus } from "./blog/save-status";
import { useT } from "@/i18n/use-t.ts";
import { HeldBlockView } from "./held-block-view";

type AppEditorProps = Parameters<typeof AppEditorForm>[0];

/**
 * An app block's settings form. The form keeps its own copy of the block:
 * on a hosted v8 draft its saves are guarded by that copy, it shows the
 * draft's copy again after a reconcile, and a block deleted from the draft
 * shows as deleted (except Settings', whose absence means "not created").
 */
export function AppEditor(props: AppEditorProps) {
  return (
    <HeldBlockView
      orgSlug={props.orgSlug}
      virtualMcpId={props.virtualMcpId}
      branch={props.branch}
      blockKey={props.blockKey}
      // Settings' block may be absent: not created yet, never "deleted".
      present={props.saveGuard ? undefined : props.block !== undefined}
    >
      <AppEditorForm {...props} />
    </HeldBlockView>
  );
}

function AppEditorForm({
  orgSlug,
  virtualMcpId,
  branch,
  blockKey,
  block,
  meta,
  decofile,
  title: titleOverride,
  excludeFields,
  previewBaseUrl = null,
  notice,
  saveGuard,
  persistDefaults,
  schemaWaiting = true,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  blockKey: string;
  block: Record<string, unknown> | undefined;
  meta: LiveMeta;
  decofile: Record<string, unknown>;
  title?: string;
  /** Top-level schema fields to omit (e.g. site `seo` is edited in the SEO tab). */
  excludeFields?: readonly string[];
  previewBaseUrl?: string | null;
  /** Shown above the form (e.g. that the block is not saved yet). */
  notice?: ReactNode;
  /** A version guard for this block's autosaves (e.g. create-only on the first save). */
  saveGuard?: SaveGuard;
  /** `false`: the form's `@default`s are saved with the first change, not when it opens. */
  persistDefaults?: boolean;
  /**
   * Whether the owner is still re-reading `/live/_meta` for this block. It
   * owns the budget that ends the wait (see `schema-poll`), and without it
   * this form promises a build that is no longer coming. Defaults to true for
   * a caller with no poll of its own, which is the behaviour it had before.
   */
  schemaWaiting?: boolean;
}) {
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const t = useT();
  /** Whether a build that could still generate this block's schema exists. */
  const session = useSessionRuntime(virtualMcpId);
  // Section-gallery previews render against the sandbox dev server, falling
  // back to the Fast Preview production deployment while the sandbox boots.
  const sectionPreviewBase = useSectionPreviewBase({
    virtualMcpId,
    branch,
    sandboxUrl: previewBaseUrl,
  });
  const resolveType =
    typeof block?.__resolveType === "string" ? block.__resolveType : "";
  const schema = resolveAppEditorSchema(resolveType, meta, excludeFields);
  const hasEditableFields = hasEditableAppEditorSchema(
    resolveType,
    meta,
    excludeFields,
  );
  /**
   * The manifest has no entry for this block yet — an app installed into the
   * working tree, waiting for the build that generates its schema. One state,
   * not two: a spinner and a message that took turns as the dev server went
   * down and came back read as two different answers to the same question.
   *
   * Only where a build is actually coming. A Fast Preview session never builds
   * anything, a block with no `__resolveType` has nothing to look up, and a
   * wait whose budget ran out is over — all three are "there is no form here",
   * and waiting on them spins forever.
   */
  const awaitingSchema =
    schemaWaiting &&
    resolveType !== "" &&
    !(session.resolved && session.runtime === "cms") &&
    !hasManifestBlockSchema(resolveType, meta);
  const title =
    titleOverride ?? (block ? appLabel(blockKey, block, meta) : blockKey);

  const { save, flush, isPending } = useDebouncedSaveBlock(
    { orgSlug, virtualMcpId, branch },
    { guard: saveGuard, holdsCopy: true },
  );
  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  // Not debounced: the saved block's form reads its value from the decofile cache, which a delay leaves stale.
  const saveReferencedBlock = createReferencedBlockSaver((refKey, data) =>
    saveBlock.mutate(
      { blockKey: refKey, data },
      {
        onError: (err) =>
          toast.error(
            t("sectionsEditor.sectionsEditor.saveFailed", {
              error: err.message,
            }),
          ),
      },
    ),
  );

  const [prevBlockKey, setPrevBlockKey] = useState(blockKey);
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  const [formResetKey, setFormResetKey] = useState(0);
  const [breadcrumbs, setBreadcrumbs] = useState<Crumb[]>([]);
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const pendingAppendRef = useRef<((item: unknown) => void) | null>(null);

  if (prevBlockKey !== blockKey) {
    setPrevBlockKey(blockKey);
    setFormValue(null);
    setFormResetKey((key) => key + 1);
    setBreadcrumbs([]);
  }

  const savedValue = (block ?? {}) as Record<string, unknown>;
  const effectiveValue = {
    ...savedValue,
    ...(formValue ?? {}),
  } as Record<string, unknown>;

  const handleChange = (next: unknown) => {
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    save(blockKey, {
      ...nextRecord,
      __resolveType: resolveType,
    });
  };

  const handleBreadcrumbChange = (next: Crumb[]) => {
    setBreadcrumbs(next);
  };

  const handleAddSectionItem = async (
    entry: SectionCatalogEntry,
    append: (item: unknown) => void,
  ) => {
    try {
      const { blockKey: newKey, data } = buildSectionBlockFromCatalogEntry(
        entry,
        decofile,
      );
      const created = await saveBlock.mutateAsync({ blockKey: newKey, data });
      // Kept the version someone else created first (hosted v8): the hook's
      // own toast said so.
      if (!keptTheirVersion(created)) {
        toast.success(t("sandbox.appEditor.createdSection", { name: newKey }));
      }
      append({ __resolveType: newKey });
      flush();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t("sandbox.appEditor.failedAddSection");
      toast.error(message);
      throw err;
    }
  };

  const handleRequestAddSection = (context: {
    append: (item: unknown) => void;
  }) => {
    pendingAppendRef.current = context.append;
    setAddSectionOpen(true);
  };

  const handleSelectSection = async (entry: SectionCatalogEntry) => {
    const append = pendingAppendRef.current;
    if (!append) return;
    try {
      await handleAddSectionItem(entry, (item) => {
        append(item);
        setAddSectionOpen(false);
        pendingAppendRef.current = null;
      });
    } catch {
      // Toast shown in handleAddSectionItem.
    }
  };

  const headerCrumbs = breadcrumbs.length > 0 ? [title, ...breadcrumbs] : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        {headerCrumbs.length > 0 ? (
          <nav
            aria-label={t("sandbox.appEditor.editingBreadcrumb")}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
          >
            {headerCrumbs.map((crumb, index) => {
              const isLast = index === headerCrumbs.length - 1;
              const crumbText = crumbLabel(crumb);
              return (
                <span
                  key={`${crumbText}-${index}`}
                  className="flex min-w-0 items-center gap-1 overflow-hidden"
                >
                  {index > 0 && (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (index === 0) {
                        handleBreadcrumbChange([]);
                      } else {
                        handleBreadcrumbChange(
                          breadcrumbsForHeaderClick(breadcrumbs, index),
                        );
                      }
                      setFormResetKey((key) => key + 1);
                    }}
                    title={crumbText}
                    className={cn(
                      "min-w-0 truncate rounded-lg px-1 py-0.5 text-left transition-colors",
                      isLast
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {crumbText}
                  </button>
                </span>
              );
            })}
          </nav>
        ) : (
          <span className="text-sm font-medium">{title}</span>
        )}
        <SaveStatus isPending={isPending} isError={false} />
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="px-6 py-6">
          <div className="mx-auto max-w-xl">
            {notice}
            {hasEditableFields ? (
              <SchemaForm
                key={`${blockKey}:${formResetKey}`}
                schema={schema!}
                value={effectiveValue}
                onChange={handleChange}
                persistDefaults={persistDefaults}
                basePath=""
                breadcrumbPath={breadcrumbs}
                onBreadcrumbChange={handleBreadcrumbChange}
                decofile={decofile}
                meta={meta}
                onSaveReferencedBlock={saveReferencedBlock}
                previewBaseUrl={sectionPreviewBase}
                onAddSectionItem={handleAddSectionItem}
                onRequestAddSection={handleRequestAddSection}
                sandbox={{ orgSlug, virtualMcpId, branch, threadId }}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 py-6 text-center text-xs text-muted-foreground">
                {awaitingSchema && <Spinner className="size-4" />}
                <p>
                  {t(
                    awaitingSchema
                      ? "sandbox.appEditor.schemaAwaitsBuild"
                      : "sandbox.appEditor.noEditableSchema",
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {sectionPreviewBase && (
        <AddSectionModal
          open={addSectionOpen}
          onOpenChange={(open) => {
            setAddSectionOpen(open);
            if (!open) pendingAppendRef.current = null;
          }}
          meta={meta}
          decofile={decofile}
          previewBaseUrl={sectionPreviewBase}
          onSelect={(entry) => {
            void handleSelectSection(entry);
          }}
        />
      )}
    </div>
  );
}
