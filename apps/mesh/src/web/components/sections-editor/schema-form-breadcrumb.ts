import { getArrayItemLabel } from "./array-item-display";
import { isPageMultivariateSectionArrayField } from "./page-variants";
import type { SchemaProperty } from "./resolve-schema";

function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function fieldDisplayLabel(key: string, schema: SchemaProperty): string {
  return schema.title ?? humanize(key);
}

/** Breadcrumb drill-down applies to array fields only (not nested objects). */
export function isArrayDrillDownField(schema: SchemaProperty): boolean {
  if (schema.type === "array" && schema.items) return true;
  return isPageMultivariateSectionArrayField(schema);
}

/** Resolve which top-level property is active for the current breadcrumb trail. */
export function resolveActiveFieldKey(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown>,
  breadcrumbPath: string[],
): string | null {
  if (breadcrumbPath.length === 0) return null;
  const head = breadcrumbPath[0]!;

  for (const key of keys) {
    const schema = properties[key];
    if (!schema || !isArrayDrillDownField(schema)) continue;
    const label = fieldDisplayLabel(key, schema);
    if (head === label || head === key) return key;
  }

  for (const key of keys) {
    const schema = properties[key];
    if (!schema || !isArrayDrillDownField(schema)) continue;
    const val = objValue[key];
    if (!Array.isArray(val)) continue;
    const itemSchema = schema.items;
    for (let i = 0; i < val.length; i++) {
      if (getArrayItemLabel(val[i], i, itemSchema) === head) return key;
    }
  }

  return null;
}

export function resolveArrayItemSelection(
  label: string,
  breadcrumbPath: string[],
  items: unknown[],
  itemSchema: SchemaProperty | undefined,
): { index: number; innerPath: string[] } | null {
  if (breadcrumbPath.length === 0) return null;

  const labelIndex = breadcrumbPath.indexOf(label);
  if (labelIndex >= 0 && breadcrumbPath.length > labelIndex + 1) {
    const itemCrumb = breadcrumbPath[labelIndex + 1]!;
    const index = items.findIndex(
      (item, i) => getArrayItemLabel(item, i, itemSchema) === itemCrumb,
    );
    if (index >= 0) {
      return { index, innerPath: breadcrumbPath.slice(labelIndex + 2) };
    }
  }

  const legacyIndex = items.findIndex(
    (item, i) => getArrayItemLabel(item, i, itemSchema) === breadcrumbPath[0],
  );
  if (legacyIndex >= 0) {
    return { index: legacyIndex, innerPath: breadcrumbPath.slice(1) };
  }

  return null;
}
