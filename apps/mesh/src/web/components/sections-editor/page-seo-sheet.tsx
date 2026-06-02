import { useState, useRef } from "react";
import { Loading01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { useSaveBlock } from "./use-save-block";
import { SchemaForm } from "./schema-form";
import { resolveSchema } from "./resolve-schema";
import type { LiveMeta } from "./resolve-schema";
import { buildSiteSeoBlockData, findSiteSeoEntry } from "./seo-block";

const AUTOSAVE_DELAY = 700;

interface PageSeoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  pageKey: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  onSaved?: () => void;
}

export function PageSeoSheet({
  open,
  onOpenChange,
  orgSlug,
  virtualMcpId,
  branch,
  pageKey,
  decofile,
  meta,
  onSaved,
}: PageSeoSheetProps) {
  const pageData = decofile[pageKey] as Record<string, unknown> | undefined;
  const seoData = pageData?.seo as Record<string, unknown> | undefined;
  const seoResolveType =
    typeof seoData?.__resolveType === "string" ? seoData.__resolveType : null;
  const seoSchema = seoResolveType ? resolveSchema(seoResolveType, meta) : null;

  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  const [prevPageKey, setPrevPageKey] = useState(pageKey);
  if (prevPageKey !== pageKey) {
    setPrevPageKey(pageKey);
    setFormValue(null);
  }

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestFormRef = useRef<Record<string, unknown> | null>(null);

  const effectiveSeoValue = formValue ?? seoData ?? {};

  const handleChange = (next: unknown) => {
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    latestFormRef.current = nextRecord;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const value = latestFormRef.current;
      if (!value || !pageData) return;
      const updatedPageData = { ...pageData, seo: value };
      saveBlock.mutate(
        { blockKey: pageKey, data: updatedPageData },
        {
          onSuccess: () => onSaved?.(),
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[400px] sm:max-w-[440px] p-0 gap-0"
      >
        <SheetHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-sm font-semibold">Page SEO</SheetTitle>
          {saveBlock.isPending && (
            <Loading01
              size={14}
              className="animate-spin text-muted-foreground"
            />
          )}
        </SheetHeader>

        {!seoSchema ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {!seoData
              ? "This page has no SEO block configured."
              : "SEO schema not found."}
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="px-6 py-4">
              <div className="mx-auto max-w-sm">
                <SchemaForm
                  schema={seoSchema}
                  value={effectiveSeoValue}
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

interface SiteSeoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  onSaved?: () => void;
}

export function SiteSeoSheet({
  open,
  onOpenChange,
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
  onSaved,
}: SiteSeoSheetProps) {
  const entry = findSiteSeoEntry(decofile);
  const seoSchema = entry ? resolveSchema(entry.seoResolveType, meta) : null;

  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestFormRef = useRef<Record<string, unknown> | null>(null);

  const effectiveSeoValue = formValue ?? entry?.seoData ?? {};

  const handleChange = (next: unknown) => {
    if (!entry) return;
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    latestFormRef.current = nextRecord;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const value = latestFormRef.current;
      if (!value) return;
      saveBlock.mutate(
        { blockKey: entry.blockKey, data: buildSiteSeoBlockData(entry, value) },
        {
          onSuccess: () => onSaved?.(),
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[400px] sm:max-w-[440px] p-0 gap-0"
      >
        <SheetHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-sm font-semibold">Site SEO</SheetTitle>
          {saveBlock.isPending && (
            <Loading01
              size={14}
              className="animate-spin text-muted-foreground"
            />
          )}
        </SheetHeader>

        {!entry || !seoSchema ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No site-level SEO block found.
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="px-6 py-4">
              <div className="mx-auto max-w-sm">
                <SchemaForm
                  schema={seoSchema}
                  value={effectiveSeoValue}
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
