import { useState } from "react";
import {
  resolveSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import type { Crumb } from "@/components/sections-editor/schema-form-breadcrumb";

/**
 * Canonical CT surface: raw CMS JSON Schema (LiveMeta) in → resolveSchema →
 * SchemaForm → edit → serialized value out. Exercises BOTH the schema
 * resolution mapping and the widget rendering/edit wiring in one shot — the
 * true "a field in the CMS schema renders the right widget and round-trips its
 * value" guarantee.
 *
 * The current value and breadcrumb trail are dumped into testid'd <pre>s so
 * specs can assert the serialized form state after interactions.
 */
export function SchemaFormHarness({
  meta,
  resolveType,
  initialValue = {},
  decofile = {},
  virtualMcpId,
}: {
  meta: LiveMeta;
  resolveType: string;
  initialValue?: Record<string, unknown>;
  decofile?: Record<string, unknown>;
  /** Renders the form inside this project (see the `use-virtual-mcp` stub). */
  virtualMcpId?: string;
}) {
  const resolved = resolveSchema(resolveType, meta);
  const [value, setValue] = useState<unknown>(initialValue);
  const [writes, setWrites] = useState(0);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);

  return (
    <div data-testid="harness">
      {resolved ? (
        <SchemaForm
          schema={resolved}
          value={value}
          onChange={(next) => {
            setValue(next);
            setWrites((n) => n + 1);
          }}
          basePath=""
          breadcrumbPath={breadcrumb}
          onBreadcrumbChange={setBreadcrumb}
          meta={meta}
          decofile={decofile}
          sandbox={
            virtualMcpId
              ? { orgSlug: "ct", virtualMcpId, branch: "draft", threadId: null }
              : undefined
          }
        />
      ) : (
        <div data-testid="resolve-null">resolveSchema returned null</div>
      )}
      <pre data-testid="form-value">{JSON.stringify(value)}</pre>
      <pre data-testid="write-count">{writes}</pre>
      <pre data-testid="breadcrumb">{JSON.stringify(breadcrumb)}</pre>
    </div>
  );
}
