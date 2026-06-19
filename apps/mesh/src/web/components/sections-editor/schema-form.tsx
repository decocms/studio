import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import type { FieldProps } from "./fields/field-props";
import { StringField } from "./fields/string-field";
import { NumberField } from "./fields/number-field";
import { BooleanField } from "./fields/boolean-field";
import { EnumField } from "./fields/enum-field";
import { ArrayField } from "./fields/array-field";
import { ObjectField } from "./fields/object-field";
import { AnyOfField } from "./fields/any-of-field";
import { FileField } from "./fields/file-field";
import { ImageField } from "./fields/image-field";
import { isSecretBlock, SecretField } from "./fields/secret-field";
import {
  isMultivariateArrayWrapper,
  isPageMultivariateSectionArrayField,
  unwrapMultivariateArrayValue,
  wrapMultivariateArrayValue,
} from "./page-variants";
import {
  breadcrumbPathForActiveField,
  fieldDisplayLabel,
  resolveActiveFieldKey,
} from "./schema-form-breadcrumb";

/** Skip internal deco properties that shouldn't be user-editable. */
const HIDDEN_PROPS = new Set(["__resolveType", "@type"]);

/**
 * Build a SchemaProperty from a runtime value so data-only fields
 * (present in page data but absent from the _meta schema) can be edited.
 *
 * When `hints` is provided (a map of known property schemas), matching keys
 * in an inferred object will use the hint's full definition (preserving
 * format, title, description, etc.) instead of a bare type-only schema.
 * This lets data-only arrays like `textSeo` inherit the parent schema's
 * rich-text format, descriptions, and labels for their items.
 */
export function inferSchemaFromValue(
  val: unknown,
  hints?: Record<string, SchemaProperty>,
): SchemaProperty | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string") return { type: "string" };
  if (typeof val === "number") return { type: "number" };
  if (typeof val === "boolean") return { type: "boolean" };
  if (Array.isArray(val)) {
    const items =
      val.length > 0 ? inferSchemaFromValue(val[0], hints) : undefined;
    return { type: "array", items };
  }
  if (typeof val === "object") {
    const properties: Record<string, SchemaProperty> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k.startsWith("__")) continue;
      // Use the hint schema when available — it carries format, title,
      // description, and other metadata that inference alone can't produce.
      const hint = hints?.[k];
      if (hint) {
        properties[k] = hint;
      } else {
        const prop = inferSchemaFromValue(v);
        if (prop) properties[k] = prop;
      }
    }
    if (Object.keys(properties).length === 0) return undefined;
    return { type: "object", properties };
  }
  return undefined;
}

function multivariateMediaKind(
  schema: SchemaProperty,
): "image" | "file" | null {
  if (schema.type !== "block-ref" || !schema.anyOfRefs?.length) return null;
  if (schema.anyOfRefs.length !== 1) return null;
  const rt = schema.anyOfRefs[0]!.resolveType;
  if (rt.endsWith("/multivariate/image.ts")) return "image";
  if (rt.endsWith("/multivariate/video.ts")) return "file";
  if (rt.endsWith("/multivariate/file.ts")) return "file";
  return null;
}

/** Infer section array items from a page-multivariate block-ref stub (site `global`). */
function inferArrayItemsFromBlockRefSchema(
  schema: SchemaProperty,
): SchemaProperty | undefined {
  if (!isPageMultivariateSectionArrayField(schema)) return undefined;
  for (const ref of schema.anyOfRefs ?? []) {
    const variants = ref.schema?.properties?.variants;
    const variantItem = variants?.items;
    const valueField = variantItem?.properties?.value;
    if (valueField?.type === "array" && valueField.items) {
      return valueField.items;
    }
  }
  return undefined;
}

function arraySchemaForValue(schema: SchemaProperty): SchemaProperty | null {
  if (schema.type === "array" && schema.items) return schema;
  const inferredItems =
    schema.items ?? inferArrayItemsFromBlockRefSchema(schema);
  if (!inferredItems) return null;
  return { ...schema, type: "array", items: inferredItems };
}

function defaultForType(
  type: string | undefined,
  defaultVal: unknown,
): unknown {
  if (defaultVal !== undefined) return defaultVal;
  switch (type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

export function renderField(props: FieldProps) {
  const { schema, value } = props;

  if (isMultivariateArrayWrapper(value)) {
    const multivariateArray = unwrapMultivariateArrayValue(value);
    const arraySchema = arraySchemaForValue(schema);
    if (multivariateArray !== null && arraySchema) {
      return (
        <ArrayField
          key={props.path}
          {...props}
          schema={arraySchema}
          value={multivariateArray}
          onChange={(next) =>
            props.onChange(wrapMultivariateArrayValue(value, next as unknown[]))
          }
        />
      );
    }
  }

  if (
    Array.isArray(value) &&
    schema.type === "block-ref" &&
    isPageMultivariateSectionArrayField(schema)
  ) {
    const arraySchema = arraySchemaForValue(schema);
    if (arraySchema) {
      return (
        <ArrayField
          key={props.path}
          {...props}
          schema={arraySchema}
          value={value}
          onChange={props.onChange}
        />
      );
    }
  }

  // Block-ref schema but the actual value is a plain array (not a
  // multivariate wrapper). Infer item schema from the first element and
  // render as ArrayField so items like menuItems [{target,href,label}]
  // become an editable draggable list.
  if (
    Array.isArray(value) &&
    !isMultivariateArrayWrapper(value) &&
    schema.type === "block-ref"
  ) {
    const items = value.length > 0 ? inferSchemaFromValue(value[0]) : undefined;
    if (items) {
      const arraySchema: SchemaProperty = { ...schema, type: "array", items };
      return (
        <ArrayField
          key={props.path}
          {...props}
          schema={arraySchema}
          value={value}
          onChange={props.onChange}
        />
      );
    }
  }

  // Block-ref field (loader/section selector with anyOfRefs)
  if (
    schema.type === "block-ref" ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).__resolveType === "string" &&
      schema.anyOfRefs)
  ) {
    // Deco wraps ImageWidget/VideoWidget in a multivariate flag loader by
    // default. When the only option is the multivariate media loader,
    // render the underlying media picker instead of a variant selector.
    const mediaKind = multivariateMediaKind(schema);
    if (mediaKind === "image") {
      return <ImageField key={props.path} {...props} />;
    }
    if (mediaKind === "file") {
      return <FileField key={props.path} {...props} />;
    }
    // For now render as object if we have properties, otherwise skip
    if (schema.anyOfRefs) {
      return <AnyOfField key={props.path} {...props} />;
    }
    return null;
  }

  // image-uri → ImageField (preview + image-only picker)
  if (schema.format === "image-uri") {
    return <ImageField key={props.path} {...props} />;
  }
  // file-uri / video-uri → FileField (filename chip + picker, video preview)
  if (schema.format === "file-uri" || schema.format === "video-uri") {
    return <FileField key={props.path} {...props} />;
  }

  // Enum (including extracted const enums)
  if (schema.enum && schema.enum.length > 0) {
    return <EnumField key={props.path} {...props} />;
  }

  // anyOf without anyOfRefs (legacy path)
  if (schema.type === "anyOf") {
    return <AnyOfField key={props.path} {...props} />;
  }

  // Deco API secrets are stored as loader blocks, not plain strings.
  if (
    isSecretBlock(value) ||
    schema.format === "password" ||
    (value == null && schema.format === "password")
  ) {
    return <SecretField key={props.path} {...props} />;
  }

  // If value is null/undefined, try to produce a typed default from schema
  const effectiveValue =
    value === null || value === undefined
      ? defaultForType(schema.type, schema.default)
      : value;

  if (effectiveValue === null || effectiveValue === undefined) {
    if (isSecretBlock(value)) {
      return <SecretField key={props.path} {...props} />;
    }
    return null;
  }

  if (isSecretBlock(effectiveValue)) {
    return <SecretField key={props.path} {...props} value={effectiveValue} />;
  }

  const effectiveProps = { ...props, value: effectiveValue };

  // Determine render type
  const renderType: string =
    value === null || value === undefined
      ? (schema.type ?? typeof effectiveValue)
      : Array.isArray(effectiveValue)
        ? "array"
        : typeof effectiveValue;

  if (renderType === "array" || Array.isArray(effectiveValue)) {
    return <ArrayField key={props.path} {...effectiveProps} />;
  }

  switch (renderType) {
    case "boolean":
      return <BooleanField key={props.path} {...effectiveProps} />;
    case "number":
    case "integer":
      return <NumberField key={props.path} {...effectiveProps} />;
    case "string": {
      // Format-based widgets
      const fmt = schema.format;
      if (fmt === "color-input") {
        return <StringField key={props.path} {...effectiveProps} />;
      }
      if (fmt === "textarea" || fmt === "rich-text" || fmt === "html") {
        return <StringField key={props.path} {...effectiveProps} />;
      }
      return <StringField key={props.path} {...effectiveProps} />;
    }
    case "object":
      if (
        effectiveValue !== null &&
        typeof effectiveValue === "object" &&
        !Array.isArray(effectiveValue)
      ) {
        return <ObjectField key={props.path} {...effectiveProps} />;
      }
      return null;
    default:
      return <StringField key={props.path} {...effectiveProps} />;
  }
}

export function SchemaForm({
  schema,
  value,
  onChange,
  basePath,
  breadcrumbPath = [],
  onBreadcrumbChange,
  meta,
  decofile,
  onSaveReferencedBlock,
  previewBaseUrl,
  onAddSectionItem,
  onRequestAddSection,
}: {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  basePath: string;
  breadcrumbPath?: string[];
  onBreadcrumbChange?: (path: string[]) => void;
  meta?: LiveMeta;
  decofile?: Record<string, unknown>;
  onSaveReferencedBlock?: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
  previewBaseUrl?: string | null;
  onAddSectionItem?: FieldProps["onAddSectionItem"];
  onRequestAddSection?: FieldProps["onRequestAddSection"];
}) {
  const properties = schema.properties;
  if (!properties) return null;

  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const keys = Object.keys(properties).filter(
    (k) => !HIDDEN_PROPS.has(k) && properties[k]?.hidden !== true,
  );

  // Gather data-only keys: present in the value but not declared in
  // the schema. This makes fields like `textSeo` (present in page data
  // but absent from the _meta schema) visible and editable.
  const dataOnlyKeys = Object.keys(objValue).filter(
    (k) =>
      !HIDDEN_PROPS.has(k) &&
      !k.startsWith("__") &&
      !properties[k] &&
      objValue[k] !== undefined,
  );
  const dataOnlySchemas: Record<string, SchemaProperty> = {};
  for (const k of dataOnlyKeys) {
    // Pass the schema's own properties as hints so that data-only arrays
    // whose items share property names with the schema (e.g. `textSeo`
    // items have `matcher`, `title`, `description` matching the schema's
    // flat properties) inherit format, title, description, and other
    // metadata — e.g. `format: "rich-text"` on the `title` field.
    const inferred = inferSchemaFromValue(objValue[k], properties);
    if (!inferred) continue;
    // When the inferred field is an array whose items matched schema hints,
    // also propagate `titleBy` from the parent schema so that the array
    // item label uses the right key (e.g. `matcher` instead of `title`
    // which may contain raw HTML).
    if (inferred.type === "array" && inferred.items && schema.titleBy) {
      inferred.items = { ...inferred.items, titleBy: schema.titleBy };
    }
    dataOnlySchemas[k] = inferred;
  }
  const allDataOnlyKeys = dataOnlyKeys.filter((k) => dataOnlySchemas[k]);

  // When ALL schema-defined field values are empty but data-only keys
  // contain the actual data (e.g. CategoryTextHero defines flat
  // `matcher, title, description, max` but the data wraps them in
  // `textSeo: [{matcher, title, description}]`), hide the empty schema
  // fields so the user only sees the populated data-only fields.
  const schemaFieldsAllEmpty =
    allDataOnlyKeys.length > 0 &&
    keys.every((k) => {
      const v = objValue[k];
      return v === undefined || v === null || v === "";
    });
  const effectiveSchemaKeys = schemaFieldsAllEmpty ? [] : keys;

  if (effectiveSchemaKeys.length === 0 && allDataOnlyKeys.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        No editable fields on this section.
      </div>
    );
  }

  const updateField = (key: string, fieldValue: unknown) => {
    onChange({ ...objValue, [key]: fieldValue });
  };

  const containerResolveType =
    typeof objValue.__resolveType === "string"
      ? objValue.__resolveType
      : undefined;

  const allKeys = [...effectiveSchemaKeys, ...allDataOnlyKeys];
  const allProperties: Record<string, SchemaProperty> = {
    ...properties,
    ...dataOnlySchemas,
  };

  const activeKey =
    breadcrumbPath.length > 0
      ? resolveActiveFieldKey(allKeys, allProperties, objValue, breadcrumbPath)
      : null;
  const activeSchema = activeKey ? allProperties[activeKey] : null;
  const visibleKeys = activeKey && activeSchema ? [activeKey] : allKeys;
  const fieldBreadcrumbPath =
    activeKey && activeSchema
      ? breadcrumbPathForActiveField(activeKey, activeSchema, breadcrumbPath)
      : breadcrumbPath;
  return (
    <div className="min-w-0 space-y-6">
      {visibleKeys.map((key) => {
        const propSchema = allProperties[key];
        if (!propSchema) return null;
        const fieldPath = basePath ? `${basePath}.${key}` : key;
        const label = fieldDisplayLabel(key, propSchema);

        return renderField({
          schema: propSchema,
          value: objValue[key],
          onChange: (val) => updateField(key, val),
          path: fieldPath,
          label,
          breadcrumbPath: fieldBreadcrumbPath,
          onBreadcrumbChange,
          meta,
          decofile,
          onSaveReferencedBlock,
          containerResolveType,
          previewBaseUrl,
          onAddSectionItem,
          onRequestAddSection,
        });
      })}
    </div>
  );
}
