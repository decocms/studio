import type { ReactNode } from "react";
import { SeoFormChrome } from "./seo-form-chrome";
import { SeoFormFields } from "./seo-form-fields";
import { SeoTypeSelect } from "./seo-type-select";
import { useT } from "@/i18n/use-t.ts";
import { useBlocksSiteEditor } from "./blocks-site-editor";
import type { SchemaProperty } from "./resolve-schema";
import type { Crumb } from "./schema-form-breadcrumb";
import type { SeoTypeOption } from "./seo-schema";
import {
  defaultEnabledSeo,
  isSeoEnabled,
  toggleSeoAsyncRender,
} from "./seo-lazy-render";

interface PageSeoFormProps {
  rawSeo: unknown;
  innerSeo: Record<string, unknown>;
  defaultResolveType: string;
  seoSchema: SchemaProperty | null;
  activeResolveType: string | null;
  seoTypeOptions?: SeoTypeOption[];
  formResetKey: number;
  siteDefaultSeo?: Record<string, unknown>;
  onBreadcrumbChange?: (path: Crumb[]) => void;
  onPersistRaw: (raw: Record<string, unknown> | null) => void;
  onInnerChange: (inner: Record<string, unknown>) => void;
  /** Clears inner form state (enable/disable). */
  onClearForm: () => void;
  /** Remounts schema widgets (type change). */
  onBumpFormKey: () => void;
  beforeFields?: ReactNode;
  /** False on v8, which has no async rendering: no switch at all. */
  asyncRenderAvailable?: boolean;
  /** The site's schema is still loading: SEO can't be turned on yet. */
  seoTypesLoading?: boolean;
}

/** Page SEO: Enable + type + fields + Async render (admin EditSEO layout). */
export function PageSeoForm({
  rawSeo,
  innerSeo,
  defaultResolveType,
  seoSchema,
  activeResolveType,
  seoTypeOptions,
  formResetKey,
  siteDefaultSeo,
  onBreadcrumbChange,
  onPersistRaw,
  onInnerChange,
  onClearForm,
  onBumpFormKey,
  beforeFields,
  asyncRenderAvailable = true,
  seoTypesLoading = false,
}: PageSeoFormProps) {
  const t = useT();
  // v8: no SEO type to start from (a page schema that lists none, or the
  // schema still loading): SEO can't be turned on, rather than saving a
  // type-less SEO block. v7 keeps its switch as before.
  const v8 = useBlocksSiteEditor();
  const seoTypeAvailable =
    !v8 || (!seoTypesLoading && defaultResolveType !== "");
  const handleEnableChange = (enabled: boolean) => {
    if (enabled) {
      if (!seoTypeAvailable) return;
      const nextRaw = defaultEnabledSeo(defaultResolveType);
      onPersistRaw(nextRaw);
      onClearForm();
      onBumpFormKey();
      return;
    }
    onPersistRaw(null);
    onClearForm();
    onBumpFormKey();
  };

  const handleAsyncRenderChange = (enabled: boolean) => {
    const nextRaw = toggleSeoAsyncRender(enabled, rawSeo);
    onPersistRaw(nextRaw);
  };

  const handleTypeChange = (nextType: string) => {
    // Drop fields from the previous type so PDP/PLP keys do not leak across.
    onInnerChange({ __resolveType: nextType });
    onBumpFormKey();
  };

  return (
    <SeoFormChrome
      rawSeo={rawSeo}
      onEnableChange={handleEnableChange}
      enableUnavailable={!seoTypeAvailable}
      enableUnavailableHint={
        seoTypeAvailable || seoTypesLoading
          ? undefined
          : t("sectionsEditor.seoFormChrome.noSeoTypeHint")
      }
      onAsyncRenderChange={
        asyncRenderAvailable ? handleAsyncRenderChange : undefined
      }
    >
      {beforeFields}
      {isSeoEnabled(rawSeo) &&
        seoSchema &&
        activeResolveType &&
        seoTypeOptions &&
        seoTypeOptions.length > 0 && (
          <SeoTypeSelect
            options={seoTypeOptions}
            value={activeResolveType}
            onChange={handleTypeChange}
          />
        )}
      {isSeoEnabled(rawSeo) && seoSchema && activeResolveType && (
        <SeoFormFields
          schema={seoSchema}
          resolveType={activeResolveType}
          value={innerSeo}
          formResetKey={formResetKey}
          onChange={(next) => onInnerChange(next as Record<string, unknown>)}
          onBreadcrumbChange={onBreadcrumbChange}
          siteDefaultSeo={siteDefaultSeo}
        />
      )}
    </SeoFormChrome>
  );
}
