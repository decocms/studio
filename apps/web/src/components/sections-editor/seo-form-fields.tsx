import type { SandboxConfig } from "./fields/field-props";
import type { SchemaProperty } from "./resolve-schema";
import { SchemaForm } from "./schema-form";
import type { Crumb } from "./schema-form-breadcrumb";
import { GeneralSeoForm } from "./general-seo-form";
import { filterSeoSchema, getSeoFormMode } from "./seo-form-mode";
import { useBlocksSiteEditor } from "./blocks-site-editor";

interface SeoFormFieldsProps {
  schema: SchemaProperty;
  resolveType: string;
  value: Record<string, unknown>;
  formResetKey: number;
  onChange: (value: unknown) => void;
  onBreadcrumbChange?: (path: Crumb[]) => void;
  /** Page SEO only — enables General "Use default" toggles. */
  siteDefaultSeo?: Record<string, unknown>;
  /** The project's session: the form follows its CMS settings (`defaultsOnCreateOnly`). */
  sandbox?: SandboxConfig;
}

/**
 * Renders SEO fields like admin: General uses BaseSEOForm fields + inherit
 * toggles; PDP/PLP use a filtered schema subset; other types use full schema.
 */
export function SeoFormFields({
  schema,
  resolveType,
  value,
  formResetKey,
  onChange,
  onBreadcrumbChange,
  siteDefaultSeo,
  sandbox,
}: SeoFormFieldsProps) {
  const v8 = useBlocksSiteEditor();
  const mode = getSeoFormMode(resolveType, schema, v8);

  if (mode === "general") {
    return (
      <GeneralSeoForm
        schema={schema}
        value={value}
        onChange={(next) => onChange(next)}
        siteDefaultSeo={siteDefaultSeo}
        formResetKey={formResetKey}
        sandbox={sandbox}
      />
    );
  }

  const filtered = filterSeoSchema(schema, resolveType, v8);

  return (
    <SchemaForm
      key={formResetKey}
      schema={filtered}
      value={value}
      onChange={onChange}
      basePath=""
      breadcrumbPath={[]}
      onBreadcrumbChange={onBreadcrumbChange ?? (() => {})}
      sandbox={sandbox}
    />
  );
}
