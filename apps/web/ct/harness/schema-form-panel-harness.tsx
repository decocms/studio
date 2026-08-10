import { useState } from "react";
import {
  resolveSchema,
  type LiveMeta,
} from "@/components/sections-editor/resolve-schema";
import { SchemaFormPanel } from "@/components/sections-editor/sections-editor-panels";
import type { Crumb } from "@/components/sections-editor/schema-form-breadcrumb";

/**
 * CT surface for the `SchemaFormPanel` boundary specifically — the panel the
 * section / global-block editors render fields through. The plain
 * `SchemaFormHarness` mounts `SchemaForm` directly, so it can't catch a panel
 * that drops a prop before reaching the form; this one can.
 *
 * It records `onRequestAddSection` invocations into a testid'd <pre> so a spec
 * can assert whether a section-array "Add section" click reached the picker
 * (prop threaded through) or was swallowed by the `!previewBaseUrl` guard.
 */
export function SchemaFormPanelHarness({
  meta,
  resolveType,
  initialValue = {},
  decofile = {},
  previewBaseUrl,
}: {
  meta: LiveMeta;
  resolveType: string;
  initialValue?: Record<string, unknown>;
  decofile?: Record<string, unknown>;
  previewBaseUrl?: string | null;
}) {
  const resolved = resolveSchema(resolveType, meta);
  const [value, setValue] = useState<unknown>(initialValue);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [events, setEvents] = useState<string[]>([]);

  return (
    <div data-testid="harness">
      <SchemaFormPanel
        activeSchema={resolved}
        formValue={value}
        formResetKey={0}
        onFormChange={setValue}
        onBreadcrumbChange={setBreadcrumb}
        breadcrumbPath={breadcrumb}
        emptyMessage="No editable fields."
        meta={meta}
        decofile={decofile}
        previewBaseUrl={previewBaseUrl}
        onRequestAddSection={() =>
          setEvents((prev) => [...prev, "requestAddSection"])
        }
      />
      <pre data-testid="form-value">{JSON.stringify(value)}</pre>
      <pre data-testid="events">{JSON.stringify(events)}</pre>
    </div>
  );
}
