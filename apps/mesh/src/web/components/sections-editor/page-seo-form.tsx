import type { ReactNode } from "react";
import { SeoFormChrome } from "./seo-form-chrome";
import { SeoFormFields } from "./seo-form-fields";
import { SeoTypeSelect } from "./seo-type-select";
import type { SchemaProperty } from "./resolve-schema";
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
  onBreadcrumbChange?: (path: string[]) => void;
  onPersistRaw: (raw: Record<string, unknown> | null) => void;
  onInnerChange: (inner: Record<string, unknown>) => void;
  /** Clears inner form state (enable/disable). */
  onClearForm: () => void;
  /** Remounts schema widgets (type change). */
  onBumpFormKey: () => void;
  beforeFields?: ReactNode;
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
}: PageSeoFormProps) {
  const handleEnableChange = (enabled: boolean) => {
    if (enabled) {
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
      onAsyncRenderChange={handleAsyncRenderChange}
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
