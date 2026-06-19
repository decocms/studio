import { ChevronRight, Loading01 } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@deco/ui/lib/utils.js";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { appLabel } from "@/web/components/sections-editor/page-list";
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import type { SectionCatalogEntry } from "@/web/components/sections-editor/section-catalog";
import { createReferencedBlockSaver } from "@/web/components/sections-editor/save-referenced-block";
import {
  useDebouncedSaveBlock,
  useSaveBlock,
} from "@/web/components/sections-editor/use-save-block";
import { resolveAppEditorSchema } from "./app-editor-schema";
import { nextUniqueBlockKey } from "./content-mutations";
import { SchemaForm } from "@/web/components/sections-editor/schema-form";
import { SaveStatus } from "./blog/save-status";

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
  const resolveType =
    typeof block?.__resolveType === "string" ? block.__resolveType : "";
  const schema = resolveAppEditorSchema(resolveType, meta, excludeFields);
  const hasEditableFields =
    !!schema && Object.keys(schema.properties ?? {}).length > 0;
  const title =
    titleOverride ?? (block ? appLabel(blockKey, block, meta) : blockKey);

  const { save, isPending } = useDebouncedSaveBlock({
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
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);

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

  const handleBreadcrumbChange = (next: string[]) => {
    setBreadcrumbs(next);
  };

  const handleAddSectionItem = async (
    entry: SectionCatalogEntry,
    append: (item: unknown) => void,
  ) => {
    const baseLabel = (entry.title || entry.resolveType.split("/").pop() || "")
      .replace(/\.(tsx?|jsx?)$/, "")
      .replace(/[^A-Za-z0-9_-]/g, "");
    const safeBase =
      /^[A-Za-z]/.test(baseLabel) && baseLabel.length > 0
        ? baseLabel
        : "Section";
    const newKey = nextUniqueBlockKey(decofile, safeBase);
    const data: Record<string, unknown> = {
      __resolveType: entry.resolveType,
      name: newKey,
    };
    await saveBlock.mutateAsync({ blockKey: newKey, data });
    toast.success(`Created section "${newKey}"`);
    append({ __resolveType: newKey });
  };

  const breadcrumbKey = breadcrumbs.join("\0");

  const headerCrumbs = breadcrumbs.length > 0 ? [title, ...breadcrumbs] : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        {headerCrumbs.length > 0 ? (
          <nav
            aria-label="Editing breadcrumb"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
          >
            {headerCrumbs.map((crumb, index) => {
              const isLast = index === headerCrumbs.length - 1;
              return (
                <span
                  key={`${crumb}-${index}`}
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
                        handleBreadcrumbChange(breadcrumbs.slice(0, index - 1));
                      }
                      setFormResetKey((key) => key + 1);
                    }}
                    title={crumb}
                    className={cn(
                      "min-w-0 truncate rounded-md px-1 py-0.5 text-left transition-colors",
                      isLast
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {crumb}
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
      <ScrollArea className="min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="px-6 py-6">
          <div className="mx-auto max-w-xl">
            {hasEditableFields ? (
              <SchemaForm
                key={`${blockKey}:${formResetKey}:${breadcrumbKey}`}
                schema={schema!}
                value={effectiveValue}
                onChange={handleChange}
                basePath=""
                breadcrumbPath={breadcrumbs}
                onBreadcrumbChange={handleBreadcrumbChange}
                decofile={decofile}
                meta={meta}
                onSaveReferencedBlock={saveReferencedBlock}
                previewBaseUrl={previewBaseUrl}
                onAddSectionItem={handleAddSectionItem}
              />
            ) : schemaPending ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-xs text-muted-foreground">
                <Loading01 size={16} className="animate-spin" />
                Loading app schema…
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No editable schema found for this app.
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
