import { useOptionalChatTask } from "@/components/chat/chat-context";
import { Button } from "@decocms/ui/components/button.tsx";
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
  isResolvableManifestApp,
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
import { resolveAppEditorSchema } from "./app-editor-schema";
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
  schemaPending = false,
  onReinstall,
  reinstalling = false,
  previewBaseUrl = null,
  notice,
  saveGuard,
  persistDefaults,
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
  schemaPending?: boolean;
  /**
   * Write the app's files again. Offered when its form came out empty and the
   * registry still knows how to write it: a bridge module an older installer
   * wrote without the app's default export resolves, and configures nothing.
   */
  onReinstall?: () => void;
  reinstalling?: boolean;
  previewBaseUrl?: string | null;
  /** Shown above the form (e.g. that the block is not saved yet). */
  notice?: ReactNode;
  /** A version guard for this block's autosaves (e.g. create-only on the first save). */
  saveGuard?: SaveGuard;
  /** `false`: the form's `@default`s are saved with the first change, not when it opens. */
  persistDefaults?: boolean;
}) {
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const t = useT();
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
  const hasEditableFields =
    !!schema && Object.keys(schema.properties ?? {}).length > 0;
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
            ) : schemaPending ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
                <Spinner className="size-4" />
                {t("sandbox.appEditor.loadingSchema")}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-6 text-center text-xs text-muted-foreground">
                <p>
                  {t(
                    isResolvableManifestApp(meta, resolveType)
                      ? "sandbox.appEditor.noEditableSchema"
                      : "sandbox.appEditor.schemaAwaitsBuild",
                  )}
                </p>
                {onReinstall && (
                  <div className="flex flex-col items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onReinstall}
                      disabled={reinstalling}
                      className="gap-2"
                    >
                      {reinstalling && <Spinner className="size-3.5" />}
                      {t("sandbox.appEditor.reinstall")}
                    </Button>
                    <span>{t("sandbox.appEditor.reinstallHint")}</span>
                  </div>
                )}
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
