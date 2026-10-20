import { useOptionalChatTask } from "@/components/chat/chat-context";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { ChevronLeft, ChevronRight } from "@untitledui/icons";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { AddSectionModal } from "@/components/sections-editor/add-section-modal";
import { useSectionPreviewBase } from "@/components/sections-editor/use-section-preview-base";
import {
  buildAppPreviewUrl,
  withDraftPointer,
} from "@/components/sections-editor/section-preview-url";
import { useDraftPointer } from "@/components/sections-editor/use-fast-preview-draft-url";
import { appLabel } from "@/components/sections-editor/page-list";
import {
  isResolvableManifestApp,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import type { SectionCatalogEntry } from "@/components/sections-editor/section-catalog";
import { createReferencedBlockSaver } from "@/components/sections-editor/save-referenced-block";
import {
  type SaveGuard,
  useDebouncedSaveBlock,
  useSaveBlock,
} from "@/components/sections-editor/use-save-block";
import { resolveAppEditorSchema } from "./app-editor-schema";
import { useLiveAppPreview } from "./use-live-app-preview";
import { buildSectionBlockFromCatalogEntry } from "./section-create";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import {
  breadcrumbsForHeaderClick,
  type Crumb,
  crumbLabel,
} from "@/components/sections-editor/schema-form-breadcrumb";
import { SaveStatus } from "./blog/save-status";
import { useT } from "@/i18n/use-t.ts";

export function AppEditor({
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
  previewBaseUrl = null,
  notice,
  saveGuard,
  persistDefaults,
  showAppPreview = false,
  onBack,
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
  previewBaseUrl?: string | null;
  /** Shown above the form (e.g. that the block is not saved yet). */
  notice?: ReactNode;
  /** A version guard for this block's autosaves (e.g. create-only on the first save). */
  saveGuard?: SaveGuard;
  /** `false`: the form's `@default`s are saved with the first change, not when it opens. */
  persistDefaults?: boolean;
  /** Show the app module's `preview` export beside the form, re-rendered as it changes. */
  showAppPreview?: boolean;
  /** Shows a back button that returns to the app list. */
  onBack?: () => void;
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
  // Under Fast Preview the base is production, which only sees branch edits through the draft pointer.
  const draftPointer = useDraftPointer({ orgSlug, virtualMcpId, branch });
  const appPreviewUrl =
    showAppPreview && sectionPreviewBase
      ? withDraftPointer(
          buildAppPreviewUrl(sectionPreviewBase, blockKey),
          draftPointer,
        )
      : null;
  const livePreview = useLiveAppPreview({
    previewBaseUrl: appPreviewUrl ? sectionPreviewBase : null,
    blockKey,
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
    { guard: saveGuard },
  );
  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  // Not debounced: the saved block's form reads its value from the decofile cache, which a delay leaves stale.
  const saveReferencedBlock = createReferencedBlockSaver((refKey, data) => {
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
    );
    // Without Fast Preview the frame never reloads, so only a render shows a nested block's edit.
    livePreview.render({
      ...decofile,
      [blockKey]: { ...effectiveValue, __resolveType: resolveType },
      [refKey]: data,
    });
  });

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
    const data = { ...nextRecord, __resolveType: resolveType };
    save(blockKey, data);
    livePreview.render({ ...decofile, [blockKey]: data });
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
      await saveBlock.mutateAsync({ blockKey: newKey, data });
      toast.success(t("sandbox.appEditor.createdSection", { name: newKey }));
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
      <div
        className={cn(
          "flex h-12 shrink-0 items-center gap-3 border-b pr-6",
          onBack ? "pl-3" : "pl-6",
        )}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={t("sandbox.appEditor.backToApps")}
            aria-label={t("sandbox.appEditor.backToApps")}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--studio-control-radius,var(--radius-md))] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
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
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
          </span>
        )}
        <SaveStatus isPending={isPending} isError={false} />
      </div>
      <div className="flex min-h-0 flex-1">
        <ScrollArea
          className={cn(
            "min-h-0 min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!block",
            appPreviewUrl ? "w-[28rem] shrink-0 border-r" : "flex-1",
          )}
        >
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
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {t(
                    isResolvableManifestApp(meta, resolveType)
                      ? "sandbox.appEditor.noEditableSchema"
                      : "sandbox.appEditor.schemaAwaitsBuild",
                  )}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
        {appPreviewUrl && (
          <div className="relative min-w-0 flex-1">
            <iframe
              ref={livePreview.frameRef}
              src={appPreviewUrl}
              onLoad={livePreview.onFrameLoad}
              // oxlint-disable-next-line react/iframe-missing-sandbox -- cross-origin src (never srcDoc): allow-same-origin keeps the preview's origin, so its fonts load
              sandbox="allow-scripts allow-same-origin allow-popups"
              title={t("sandbox.appEditor.previewFrameTitle", { name: title })}
              className="size-full border-0 bg-white"
            />
            {livePreview.failed && (
              <div className="absolute inset-x-0 bottom-0 bg-destructive px-4 py-2 text-xs text-destructive-foreground">
                {t("sandbox.appEditor.previewFailed")}
              </div>
            )}
          </div>
        )}
      </div>

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
