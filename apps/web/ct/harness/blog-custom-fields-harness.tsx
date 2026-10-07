import { useState } from "react";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { CustomFieldsPanel } from "@/components/sandbox/content/blog/custom-fields-panel";
import {
  blogCustomFieldsSchema,
  KNOWN_POST_FIELDS,
} from "@/components/sandbox/content/blog/blog-schema";

/**
 * Mounts the blog's custom-fields panel over a real `LiveMeta`, the same way a
 * post editor does. Dumps the record payload and a save counter so specs can
 * assert both that edits round-trip and that merely opening the panel never
 * writes (which on a post would bump `dateModified`).
 */
export function BlogCustomFieldsHarness({
  meta,
  initialValue = {},
}: {
  meta: LiveMeta;
  initialValue?: Record<string, unknown>;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(initialValue);
  const [writes, setWrites] = useState(0);
  const schema = blogCustomFieldsSchema("posts", meta, KNOWN_POST_FIELDS);

  return (
    <div data-testid="harness">
      <CustomFieldsPanel
        schema={schema}
        value={value}
        onChange={(next) => {
          setValue(next);
          setWrites((n) => n + 1);
        }}
        basePath="post"
        meta={meta}
      />
      <pre data-testid="record-value">{JSON.stringify(value)}</pre>
      <pre data-testid="write-count">{writes}</pre>
    </div>
  );
}
