import type { ComponentProps } from "react";
import { SchemaForm } from "@/components/sections-editor/schema-form";
import { ObjectFieldExpansionProvider } from "@/components/sections-editor/object-field-expansion";

/**
 * `SchemaForm` that does not write its schema's `@default`s back on mount.
 *
 * `RootSchemaForm` seeds missing defaults and pushes them through `onChange`.
 * In the blog editors that `onChange` is the autosave — on a post it also
 * stamps `dateModified` — so merely opening a record would re-save it the
 * moment the site's type declares a default. Supplying the expansion store
 * here makes `SchemaForm` render its body directly and skip that seeding;
 * defaults still apply to records created after the field exists.
 */
export function SchemaFormWithoutDefaultSeeding(
  props: ComponentProps<typeof SchemaForm>,
) {
  return (
    <ObjectFieldExpansionProvider>
      <SchemaForm {...props} />
    </ObjectFieldExpansionProvider>
  );
}
