import { useState } from "react";
import { renderField } from "@/components/sections-editor/schema-form";
import type { Crumb } from "@/components/sections-editor/schema-form-breadcrumb";
import type {
  LiveMeta,
  SchemaProperty,
} from "@/components/sections-editor/resolve-schema";

/**
 * Single-field CT surface: render one already-resolved SchemaProperty via
 * `renderField` with internal value + breadcrumb state. Use this when a
 * hand-crafted SchemaProperty (e.g. a `block-ref` with `anyOfRefs`, or a
 * specific `format`) is more direct to express than a full JSON Schema fed
 * through resolveSchema.
 */
export function FieldHarness({
  schema,
  initialValue = null,
  path = "field",
  label = "Field",
  meta,
  decofile = {},
}: {
  schema: SchemaProperty;
  initialValue?: unknown;
  path?: string;
  label?: string;
  meta?: LiveMeta;
  decofile?: Record<string, unknown>;
}) {
  const [value, setValue] = useState<unknown>(initialValue);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);

  return (
    <div data-testid="harness">
      {renderField({
        schema,
        value,
        onChange: setValue,
        path,
        label,
        breadcrumbPath: breadcrumb,
        onBreadcrumbChange: setBreadcrumb,
        meta,
        decofile,
      })}
      <pre data-testid="form-value">{JSON.stringify(value)}</pre>
      <pre data-testid="breadcrumb">{JSON.stringify(breadcrumb)}</pre>
    </div>
  );
}
