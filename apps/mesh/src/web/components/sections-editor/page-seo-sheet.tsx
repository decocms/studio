import { useState } from "react";
import { Loading01 } from "@untitledui/icons";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { SchemaForm } from "./schema-form";
import { resolveSchema } from "./resolve-schema";
import type { LiveMeta } from "./resolve-schema";
import { resolveSeoTarget } from "./seo-block";
import type { SeoTarget } from "./seo-block";
import { activeSeoResolveType, useSeoFormSave } from "./seo-save";
import { SeoTypeSelect } from "./seo-type-select";

interface SeoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  target: SeoTarget;
  onSaved?: () => void;
}

/**
 * Form-only SEO editor rendered as a right-hand drawer (used from the preview
 * toolbar, where the two-pane SeoEditor would crowd the iframe). Shares the
 * same block resolution and debounced-save loop as the editor — the only
 * difference is the chrome and the lack of a live-preview pane.
 */
export function SeoSheet({
  open,
  onOpenChange,
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
  target,
  onSaved,
}: SeoSheetProps) {
  const resolved = resolveSeoTarget(decofile, target, meta);

  const targetId = target.kind === "site" ? "site" : target.pageKey;
  const [prevTargetId, setPrevTargetId] = useState(targetId);
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  const [formResetKey, setFormResetKey] = useState(0);
  if (prevTargetId !== targetId) {
    setPrevTargetId(targetId);
    setFormValue(null);
    setFormResetKey((k) => k + 1);
  }

  const { persistSeo, flush, isPending } = useSeoFormSave({
    orgSlug,
    virtualMcpId,
    branch,
    target,
    resolved,
    onSaved,
  });

  const effectiveSeo = formValue ?? resolved?.seoData ?? {};
  const activeResolveType = resolved
    ? activeSeoResolveType(effectiveSeo, resolved)
    : null;
  const seoSchema = activeResolveType
    ? resolveSchema(activeResolveType, meta)
    : null;

  const handleChange = (next: unknown) => {
    if (!resolved) return;
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    persistSeo(nextRecord);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) flush();
    onOpenChange(nextOpen);
  };

  const title = target.kind === "site" ? "Site SEO" : "Page SEO";
  const emptyMessage =
    target.kind === "site"
      ? "No site-level SEO block found."
      : seoSchema
        ? "No editable SEO fields found."
        : "SEO schema not found for this page.";

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="w-[400px] sm:max-w-[440px] p-0 gap-0"
      >
        <SheetHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-sm font-semibold">{title}</SheetTitle>
          {isPending && (
            <Loading01
              size={14}
              className="animate-spin text-muted-foreground"
            />
          )}
        </SheetHeader>

        {!resolved || !seoSchema ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="px-6 py-4">
              <div className="mx-auto max-w-sm">
                {resolved.seoTypeOptions && activeResolveType && (
                  <SeoTypeSelect
                    options={resolved.seoTypeOptions}
                    value={activeResolveType}
                    onChange={(nextType) => {
                      const nextRecord = {
                        ...effectiveSeo,
                        __resolveType: nextType,
                      };
                      setFormValue(nextRecord);
                      setFormResetKey((k) => k + 1);
                      persistSeo(nextRecord);
                    }}
                  />
                )}
                <SchemaForm
                  key={formResetKey}
                  schema={seoSchema}
                  value={effectiveSeo}
                  onChange={handleChange}
                  basePath=""
                  breadcrumbPath={[]}
                  onBreadcrumbChange={() => {}}
                />
              </div>
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
