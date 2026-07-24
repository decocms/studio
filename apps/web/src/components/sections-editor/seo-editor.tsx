import { useState } from "react";
import { ChevronRight, CreditCardSearch, Loading01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { useT } from "@/i18n/use-t.ts";
import { SeoFormFields } from "./seo-form-fields";
import { resolveSchema } from "./resolve-schema";
import type { LiveMeta } from "./resolve-schema";
import { findSiteSeoEntry, resolveSeoTarget } from "./seo-block";
import type { SeoTarget } from "./seo-block";
import { isSeoEnabled, unwrapSeoConfig } from "./seo-lazy-render";
import { PageSeoForm } from "./page-seo-form";
import { defaultPageSeoResolveType } from "./seo-schema";
import { activeSeoResolveType, useSeoFormSave } from "./seo-save";
import { SeoPreview } from "./seo-preview";

export type { SeoTarget } from "./seo-block";

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
  const t = useT();
  const resolved = resolveSeoTarget(decofile, target, meta);
  const seoData = resolved?.seoData;

  const targetId = target.kind === "site" ? "site" : target.pageKey;
  const [prevTargetId, setPrevTargetId] = useState(targetId);
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  const [formResetKey, setFormResetKey] = useState(0);
  const [rawSeoOverride, setRawSeoOverride] = useState<
    Record<string, unknown> | null | undefined
  >(undefined);
  if (prevTargetId !== targetId) {
    setPrevTargetId(targetId);
    setFormValue(null);
    setRawSeoOverride(undefined);
    setFormResetKey((k) => k + 1);
  }

  const { persistSeo, persistRawSeo, flush, isPending } = useSeoFormSave({
    orgSlug,
    virtualMcpId,
    branch,
    target,
    resolved,
    onSaved,
  });

  const isPageTarget = target.kind === "page";
  const savedRawSeo = isPageTarget ? resolved?.rawSeoData : undefined;
  const displayRawSeo =
    rawSeoOverride !== undefined ? rawSeoOverride : savedRawSeo;
  const innerFromSaved = isPageTarget
    ? (unwrapSeoConfig(displayRawSeo) ?? undefined)
    : undefined;
  const effectiveSeo = (formValue ?? innerFromSaved ?? seoData ?? {}) as Record<
    string,
    unknown
  >;
  const activeResolveType = resolved
    ? activeSeoResolveType(effectiveSeo, resolved)
    : null;
  const seoSchema =
    activeResolveType && (isPageTarget ? isSeoEnabled(displayRawSeo) : true)
      ? resolveSchema(activeResolveType, meta)
      : null;
  const defaultResolveType = defaultPageSeoResolveType(meta);

  const siteDefaultSeo =
    target.kind === "page"
      ? (findSiteSeoEntry(decofile, meta)?.seoData ?? {})
      : {};
  const previewSeo =
    target.kind === "page"
      ? mergeSeo(siteDefaultSeo, effectiveSeo)
      : effectiveSeo;

  const handleChange = (next: unknown) => {
    if (!resolved) return;
    const nextRecord = next as Record<string, unknown>;
    setFormValue(nextRecord);
    persistSeo(nextRecord);
  };

  const clearSeoForm = () => setFormValue(null);
  const bumpSeoFormKey = () => setFormResetKey((k) => k + 1);

  const handleBack = () => {
    flush();
    onBack?.();
  };

  const path = target.kind === "page" ? target.path : "/";
  const previewUrl =
    target.kind === "page" && previewBaseUrl
      ? safeUrl(path, previewBaseUrl)
      : (previewBaseUrl ?? null);

  const emptyMessage =
    target.kind === "site"
      ? t("sectionsEditor.seoEditor.noSiteSeoBlock")
      : resolved
        ? t("sectionsEditor.seoEditor.noSeoSchema")
        : t("sectionsEditor.seoEditor.couldNotLoadSeo");
  const showPageSeoChrome = isPageTarget && resolved;
  const showSiteForm = target.kind === "site" && resolved && seoSchema;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {target.kind === "page" ? (
          <nav className="flex min-w-0 items-center gap-1 text-sm">
            <button
              type="button"
              onClick={handleBack}
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
            <span className="text-sm font-medium">
              {t("sectionsEditor.seoEditor.defaultSeoLabel")}
            </span>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              · {t("sectionsEditor.seoEditor.appliedToEveryPage")}
            </span>
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isPending && (
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
              {t("sectionsEditor.seoEditor.editDefaultSeoButton")}
            </Button>
          )}
        </div>
      </div>

      {!resolved || (!showPageSeoChrome && !showSiteForm) ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ScrollArea className="w-full max-w-md shrink-0 border-r [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="px-5 py-4">
              {showPageSeoChrome ? (
                <>
                  <p className="mb-3 text-xs text-muted-foreground">
                    {t("sectionsEditor.seoEditor.emptyFieldsHint")}
                  </p>
                  <PageSeoForm
                    rawSeo={displayRawSeo}
                    innerSeo={effectiveSeo}
                    defaultResolveType={defaultResolveType}
                    seoSchema={seoSchema}
                    activeResolveType={activeResolveType}
                    seoTypeOptions={resolved.seoTypeOptions}
                    formResetKey={formResetKey}
                    siteDefaultSeo={siteDefaultSeo}
                    onPersistRaw={(raw) => {
                      setRawSeoOverride(raw);
                      persistRawSeo(raw);
                    }}
                    onInnerChange={(inner) => {
                      setFormValue(inner);
                      persistSeo(inner);
                    }}
                    onClearForm={clearSeoForm}
                    onBumpFormKey={bumpSeoFormKey}
                  />
                </>
              ) : (
                seoSchema &&
                activeResolveType && (
                  <SeoFormFields
                    schema={seoSchema}
                    resolveType={activeResolveType}
                    value={effectiveSeo}
                    formResetKey={formResetKey}
                    onChange={handleChange}
                  />
                )
              )}
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

function mergeSeo(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const pageRt = override.__resolveType;
  const siteRt = base.__resolveType;
  if (
    typeof pageRt === "string" &&
    typeof siteRt === "string" &&
    pageRt !== siteRt
  ) {
    return { ...override };
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__resolveType") continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    merged[key] = value;
  }
  return merged;
}
