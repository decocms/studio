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

function asObjectRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Resolve which property at this level should be shown for the breadcrumb trail. */
function resolveActiveFieldKeyInScope(
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

  for (const key of keys) {
    const schema = properties[key];
    if (schema?.type !== "object" || !schema.properties) continue;
    const childKeys = Object.keys(schema.properties);
    const childObj = asObjectRecord(objValue[key]);
    const label = fieldDisplayLabel(key, schema);

    const direct = resolveActiveFieldKeyInScope(
      childKeys,
      schema.properties,
      childObj,
      breadcrumbPath,
    );
    if (direct) return key;

    if (head === label || head === key) {
      const viaLabel = resolveActiveFieldKeyInScope(
        childKeys,
        schema.properties,
        childObj,
        breadcrumbPath.slice(1),
      );
      if (viaLabel) return key;
    }
  }

  return null;
}

/** Resolve which top-level property is active for the current breadcrumb trail. */
export function resolveActiveFieldKey(
  keys: string[],
  properties: Record<string, SchemaProperty>,
  objValue: Record<string, unknown>,
  breadcrumbPath: string[],
): string | null {
  return resolveActiveFieldKeyInScope(
    keys,
    properties,
    objValue,
    breadcrumbPath,
  );
}

/** True when the breadcrumb trail targets a field inside this object. */
export function isBreadcrumbInsideObject(
  fieldKey: string,
  label: string,
  schema: SchemaProperty,
  objValue: Record<string, unknown>,
  breadcrumbPath: string[],
): boolean {
  if (breadcrumbPath.length === 0 || !schema.properties) return false;

  const keys = Object.keys(schema.properties);
  if (
    resolveActiveFieldKeyInScope(
      keys,
      schema.properties,
      objValue,
      breadcrumbPath,
    )
  ) {
    return true;
  }

  const head = breadcrumbPath[0]!;
  if (head !== label && head !== fieldKey) return false;

  return (
    breadcrumbPath.length > 1 ||
    resolveActiveFieldKeyInScope(
      keys,
      schema.properties,
      objValue,
      breadcrumbPath.slice(1),
    ) !== null
  );
}

export function resolveArrayItemSelection(
  label: string,
  breadcrumbPath: string[],
  items: unknown[],
  itemSchema: SchemaProperty | undefined,
): { index: number; innerPath: string[] } | null {
  if (breadcrumbPath.length === 0) return null;

  for (let pi = 0; pi < breadcrumbPath.length; pi++) {
    const crumb = breadcrumbPath[pi]!;
    const index = items.findIndex(
      (item, i) => getArrayItemLabel(item, i, itemSchema) === crumb,
    );
    if (index >= 0) {
      return { index, innerPath: breadcrumbPath.slice(pi + 1) };
    }
  }

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

  return null;
}
