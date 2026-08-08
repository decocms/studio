import { ChevronRight, Loading01 } from "@untitledui/icons";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { AddSectionModal } from "@/components/sections-editor/add-section-modal";
import { useSectionPreviewBase } from "@/components/sections-editor/use-section-preview-base";
import { appLabel } from "@/components/sections-editor/page-list";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { SectionCatalogEntry } from "@/components/sections-editor/section-catalog";
import { createReferencedBlockSaver } from "@/components/sections-editor/save-referenced-block";
import {
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
}) {
  const t = useT();
  // Section-gallery previews render against the sandbox dev server, falling
  // back to the Fast Preview production deployment while the sandbox boots.
  const sectionPreviewBase = useSectionPreviewBase({
    virtualMcpId,
    sandboxUrl: previewBaseUrl,
  });
  const resolveType =
    typeof block?.__resolveType === "string" ? block.__resolveType : "";
  const schema = resolveAppEditorSchema(resolveType, meta, excludeFields);
  const hasEditableFields =
    !!schema && Object.keys(schema.properties ?? {}).length > 0;
  const title =
    titleOverride ?? (block ? appLabel(blockKey, block, meta) : blockKey);

  const { save, flush, isPending } = useDebouncedSaveBlock({
    orgSlug,
    virtualMcpId,
    branch,
  });
  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const saveReferencedBlock = createReferencedBlockSaver((refKey, data) =>
    save(refKey, data),
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
                      "min-w-0 truncate rounded-md px-1 py-0.5 text-left transition-colors",
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
            {hasEditableFields ? (
              <SchemaForm
                key={`${blockKey}:${formResetKey}`}
                schema={schema!}
                value={effectiveValue}
                onChange={handleChange}
                basePath=""
                breadcrumbPath={breadcrumbs}
                onBreadcrumbChange={handleBreadcrumbChange}
                decofile={decofile}
                meta={meta}
                onSaveReferencedBlock={saveReferencedBlock}
                previewBaseUrl={sectionPreviewBase}
                onAddSectionItem={handleAddSectionItem}
                onRequestAddSection={handleRequestAddSection}
                sandbox={{ orgSlug, virtualMcpId, branch }}
              />
            ) : schemaPending ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
                <Loading01 size={16} className="animate-spin" />
                {t("sandbox.appEditor.loadingSchema")}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {t("sandbox.appEditor.noEditableSchema")}
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
