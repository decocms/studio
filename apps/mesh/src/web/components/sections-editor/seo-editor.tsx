import { useRef, useState } from "react";
import { ChevronRight, CreditCardSearch, Loading01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { useSaveBlock } from "./use-save-block";
import { SchemaForm } from "./schema-form";
import { resolveSchema } from "./resolve-schema";
import type { LiveMeta } from "./resolve-schema";
import { buildSiteSeoBlockData, findSiteSeoEntry } from "./seo-block";
import { SeoPreview } from "./seo-preview";

const AUTOSAVE_DELAY = 700;

export type SeoTarget =
  | { kind: "page"; pageKey: string; pageName: string; path: string }
  | { kind: "site" };

interface SeoEditorProps {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  target: SeoTarget;
  /** Sandbox preview base URL — used to render the host/path in the previews. */
  previewBaseUrl?: string | null;
  onSaved?: () => void;
  /** Page targets only: jump to the site/default SEO editor. */
  onEditDefaultSeo?: () => void;
  /** Page targets only: breadcrumb back to the page's section editor. */
  onBack?: () => void;
}

interface ResolvedSeo {
  blockKey: string;
  seoData: Record<string, unknown> | undefined;
  /** resolveType to resolve the form schema with. */
  seoResolveType: string;
  /** Builds the full decofile block payload to persist an edited SEO value. */
  build: (value: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Resolves the SEO block + write target for a page or the site default.
 */
function resolveTarget(
  decofile: Record<string, unknown>,
  target: SeoTarget,
): ResolvedSeo | null {
  if (target.kind === "site") {
    const entry = findSiteSeoEntry(decofile);
    if (!entry) return null;
    return {
      blockKey: entry.blockKey,
      seoData: entry.seoData,
      seoResolveType: entry.seoResolveType,
      build: (value) => buildSiteSeoBlockData(entry, value),
    };
  }
  const blockData = decofile[target.pageKey] as
    | Record<string, unknown>
    | undefined;
  if (!blockData) return null;
  const seo = blockData.seo as Record<string, unknown> | undefined;
  return {
    blockKey: target.pageKey,
    seoData: seo,
    seoResolveType:
      typeof seo?.__resolveType === "string"
        ? seo.__resolveType
        : "website/sections/Seo/SeoV2.tsx",
    build: (value) => ({ ...blockData, seo: value }),
  };
}

export function SeoEditor({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
  target,
  previewBaseUrl,
  onSaved,
  onEditDefaultSeo,
  onBack,
}: SeoEditorProps) {
  const resolved = resolveTarget(decofile, target);
  const seoData = resolved?.seoData;
  const seoSchema = resolved
    ? resolveSchema(resolved.seoResolveType, meta)
    : null;

  const targetId = target.kind === "site" ? "site" : target.pageKey;
  const [prevTargetId, setPrevTargetId] = useState(targetId);
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  if (prevTargetId !== targetId) {
    setPrevTargetId(targetId);
    setFormValue(null);
  }

  const saveBlock = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestFormRef = useRef<Record<string, unknown> | null>(null);

  const effectiveSeo = formValue ?? seoData ?? {};

  // For a page, the live result is the site default with the page's own
  // (non-empty) values layered on top — that's what actually renders. The form
  // still edits only the page's own values, so inheritance isn't baked in.
  const siteDefaultSeo =
    target.kind === "page" ? (findSiteSeoEntry(decofile)?.seoData ?? {}) : {};
  const previewSeo =
    target.kind === "page"
      ? mergeSeo(siteDefaultSeo, effectiveSeo)
      : effectiveSeo;

  const handleChange = (next: unknown) => {
    if (!resolved) return;
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    latestFormRef.current = nextRecord;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const value = latestFormRef.current;
      if (!value) return;
      saveBlock.mutate(
        { blockKey: resolved.blockKey, data: resolved.build(value) },
        {
          onSuccess: () => onSaved?.(),
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }, AUTOSAVE_DELAY);
  };

  const path = target.kind === "page" ? target.path : "/";
  const previewUrl =
    target.kind === "page" && previewBaseUrl
      ? safeUrl(path, previewBaseUrl)
      : (previewBaseUrl ?? null);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {target.kind === "page" ? (
          <nav className="flex min-w-0 items-center gap-1 text-sm">
            <button
              type="button"
              onClick={onBack}
              title={target.pageName}
              className="min-w-0 truncate rounded-md px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {target.pageName}
            </button>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
            <span className="px-1 py-0.5 font-medium text-foreground">SEO</span>
          </nav>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <CreditCardSearch
              size={16}
              className="shrink-0 text-muted-foreground"
            />
            <span className="text-sm font-medium">Default SEO</span>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              · applied to every page unless overridden
            </span>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {saveBlock.isPending && (
            <Loading01
              size={14}
              className="animate-spin text-muted-foreground"
            />
          )}
          {target.kind === "page" && onEditDefaultSeo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onEditDefaultSeo}
            >
              <CreditCardSearch size={14} />
              Edit default SEO
            </Button>
          )}
        </div>
      </div>

      {/* Two-pane: form + live previews */}
      {!resolved ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          No default SEO block found in this site.
        </div>
      ) : !seoSchema ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {seoData
            ? "SEO schema not found."
            : "This page has no SEO block configured."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ScrollArea className="w-full max-w-md shrink-0 border-r [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="px-5 py-4">
              {target.kind === "page" && (
                <p className="mb-3 text-xs text-muted-foreground">
                  Empty fields inherit the default SEO. The preview shows the
                  resolved result.
                </p>
              )}
              <SchemaForm
                schema={seoSchema}
                value={effectiveSeo}
                onChange={handleChange}
                basePath=""
                breadcrumbPath={[]}
                onBreadcrumbChange={() => {}}
              />
            </div>
          </ScrollArea>
          <ScrollArea className="min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="@container px-5 py-4">
              <SeoPreview seo={previewSeo} url={previewUrl} path={path} />
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function safeUrl(path: string, base: string): string | null {
  try {
    return new URL(path, base).href;
  } catch {
    return base;
  }
}

/**
 * Layers a page's own SEO over the site default — a field is overridden only
 * when the page sets a non-empty value, mirroring how deco resolves SEO at
 * render time. Used for the preview, never for the editable form value.
 */
function mergeSeo(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__resolveType") continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    merged[key] = value;
  }
  return merged;
}
