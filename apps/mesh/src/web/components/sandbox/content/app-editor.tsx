import { Loading01 } from "@untitledui/icons";
import { useState } from "react";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { appLabel } from "@/web/components/sections-editor/page-list";
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { resolveAppEditorSchema } from "./app-editor-schema";
import { SchemaForm } from "@/web/components/sections-editor/schema-form";
import { useDebouncedSaveBlock } from "@/web/components/sections-editor/use-save-block";
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

  const savedValue = block ?? {};
  const effectiveValue = (formValue ?? savedValue) as Record<string, unknown>;

  const handleChange = (next: unknown) => {
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    save(blockKey, {
      ...nextRecord,
      __resolveType: resolveType,
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="text-sm font-medium">{title}</span>
        <SaveStatus isPending={isPending} isError={false} />
      </div>
      <ScrollArea className="min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
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
                onBreadcrumbChange={setBreadcrumbs}
                decofile={decofile}
                meta={meta}
                onSaveReferencedBlock={(refKey, data) => save(refKey, data)}
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
