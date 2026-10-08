import { useState } from "react";
import { Settings01 } from "@untitledui/icons";
import type { Crumb } from "@/components/sections-editor/schema-form-breadcrumb";
import { InlineBreadcrumb } from "@/components/sections-editor/inline-breadcrumb";
import { SchemaFormWithoutDefaultSeeding } from "./schema-form-without-default-seeding";
import type {
  LiveMeta,
  SchemaProperty,
} from "@/components/sections-editor/resolve-schema";
import type { SandboxConfig } from "@/components/sections-editor/fields/field-props";
import type { ReferencedBlockSaveFn } from "@/components/sections-editor/save-referenced-block";
import { useT } from "@/i18n/use-t.ts";
import { CollapsibleSection } from "./editor-section";

/**
 * The fields of a blog record that no bespoke control covers — typically the
 * ones a client added to the type in their fork of the blog app.
 *
 * Renders nothing when `schema` is null: the record's hardcoded fields then
 * stand alone, exactly as before.
 *
 * `value` is the WHOLE record payload even though `schema` describes only a
 * slice of it. `SchemaFormBody` renders just the keys its schema names and its
 * `updateField` spreads the rest through untouched, so this is lossless —
 * whereas handing it a pruned object and merging the result back would lose
 * keys whenever a field is cleared.
 */
export function CustomFieldsPanel({
  schema,
  value,
  onChange,
  basePath,
  meta,
  decofile,
  sandbox,
  onSaveReferencedBlock,
}: {
  schema: SchemaProperty | null;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  basePath: string;
  meta: LiveMeta;
  decofile?: Record<string, unknown>;
  sandbox?: SandboxConfig;
  /**
   * Where to persist edits to a field that points at a saved block. Without it
   * `AnyOfField` writes the referenced block's props inline and drops the
   * pointer, detaching the record from the block it was sharing.
   */
  onSaveReferencedBlock?: ReferencedBlockSaveFn;
}) {
  const t = useT();
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);

  if (!schema) return null;

  return (
    <CollapsibleSection
      icon={Settings01}
      title={t("sandbox.blogCustomFields.title")}
    >
      <p className="mb-4 text-xs text-muted-foreground">
        {t("sandbox.blogCustomFields.description")}
      </p>
      <InlineBreadcrumb
        path={breadcrumb}
        onNavigate={setBreadcrumb}
        label={t("sandbox.blogCustomFields.breadcrumbLabel")}
        backTitle={t("sandbox.blogCustomFields.backToFields")}
      />
      <SchemaFormWithoutDefaultSeeding
        schema={schema}
        value={value}
        onChange={(next) => onChange(next as Record<string, unknown>)}
        basePath={basePath}
        breadcrumbPath={breadcrumb}
        onBreadcrumbChange={setBreadcrumb}
        meta={meta}
        decofile={decofile}
        sandbox={sandbox}
        onSaveReferencedBlock={onSaveReferencedBlock}
      />
    </CollapsibleSection>
  );
}
