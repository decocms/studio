import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import type { FieldProps } from "./fields/field-props";
import { StringField } from "./fields/string-field";
import { NumberField } from "./fields/number-field";
import { BooleanField } from "./fields/boolean-field";
import { EnumField } from "./fields/enum-field";
import { ArrayField } from "./fields/array-field";
import { ObjectField } from "./fields/object-field";
import { AnyOfField } from "./fields/any-of-field";
import { DynamicOptionsField } from "./fields/dynamic-options-field";
import { FileField } from "./fields/file-field";
import { ImageField } from "./fields/image-field";
import { InlineUnionField } from "./fields/inline-union-field";
import { LocationField } from "./fields/location-field";
import { MapField } from "./fields/map-field";
import { MultivariateFieldWrapper } from "./fields/multivariate-field-wrapper";
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
import { inferBlockRefArrayItemSchema } from "./block-ref-array-inference";

/** Skip internal deco properties that shouldn't be user-editable. */
const HIDDEN_PROPS = new Set(["__resolveType", "@type"]);

/**
 * Detect whether a block-ref schema is a multivariate flag wrapper.
 *
 * Returns `true` when the schema is a single-option block-ref whose
 * wrapper has a `variants` property — i.e., it follows the
 * `MultivariateProps<T>` pattern regardless of the resolve type path.
 *
 * The check only requires `properties.variants` to exist on the wrapper
 * schema; it does NOT require the deep path `variants.items.properties.value`
 * because schema depth limits may prevent full resolution of nested types.
 */
function isMultivariateBlockRef(schema: SchemaProperty): boolean {
  if (schema.type !== "block-ref" || !schema.anyOfRefs?.length) return false;
  if (schema.anyOfRefs.length !== 1) return false;
  const wrapperSchema = schema.anyOfRefs[0]!.schema;
  // When the wrapper schema is fully resolved, check for `variants` property.
  if (wrapperSchema?.properties?.variants) return true;
  // When depth limits prevent resolution (schema undefined), fall back to
  // checking plainSchema: its presence means exactly one non-loader branch
  // existed alongside the single loader — the multivariate widget pattern.
  if (!wrapperSchema && schema.plainSchema) return true;
  return false;
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

  // Block-ref schema but the actual value is already a resolved plain array
  // (not a multivariate wrapper).  The loader has been evaluated and the page
  // data holds the concrete items — render as ArrayField so users can edit
  // them directly (e.g. menuItems [{target,href,label}]).
  if (
    Array.isArray(value) &&
    !isMultivariateArrayWrapper(value) &&
    schema.type === "block-ref"
  ) {
    const items = inferBlockRefArrayItemSchema(value);
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
    // Deco wraps widget types (ImageWidget, Message, custom types) in a
    // multivariate flag loader. When the only option is a multivariate
    // wrapper, detect the variant value type from the schema and render
    // the appropriate inner field with variant management UI.
    if (isMultivariateBlockRef(schema)) {
      const ref = schema.anyOfRefs![0]!;
      // Try to extract the variant value schema from the deep path.
      // This may be undefined when schema depth limits prevent full
      // resolution of nested types (variants.items not resolved).
      const variantValueSchema =
        ref.schema?.properties?.variants?.items?.properties?.value;
      // Determine the schema for the inner (plain) field. Priority:
      // 1. variant value schema (when fully resolved and non-circular)
      // 2. plainSchema on the outer block-ref (non-loader branch preserved
      //    during resolution, e.g. { type: "string", format: "image-uri" })
      // 3. plainSchema on the variant value schema (circular block-ref)
      const innerSchema =
        variantValueSchema && variantValueSchema.type !== "block-ref"
          ? variantValueSchema
          : (schema.plainSchema ??
            variantValueSchema?.plainSchema ?? { type: "string" });
      const innerRenderer = (fieldProps: FieldProps) =>
        renderField({ ...fieldProps, schema: innerSchema });
      return (
        <MultivariateFieldWrapper
          key={props.path}
          {...props}
          multivariateResolveType={ref.resolveType}
          renderInnerField={innerRenderer}
        />
      );
    }
    // For now render as object if we have properties, otherwise skip
    if (schema.anyOfRefs) {
      return <AnyOfField key={props.path} {...props} />;
    }
    return null;
  }

  // inline-union → branch selector for plain "A or B" data unions (Location | Map)
  if (schema.type === "inline-union") {
    return <InlineUnionField key={props.path} {...props} />;
  }

  // image-uri → ImageField (preview + image-only picker)
  if (schema.format === "image-uri") {
    return <ImageField key={props.path} {...props} />;
  }
  // file-uri / video-uri → FileField (filename chip + picker, video preview)
  if (schema.format === "file-uri" || schema.format === "video-uri") {
    return <FileField key={props.path} {...props} />;
  }

  // map → MapField (Google Maps area selector encoded as "lat,lng,radius")
  if (schema.format === "map") {
    return <MapField key={props.path} {...props} />;
  }

  // dynamic-options → DynamicOptionsField (select with options from a loader)
  if (schema.format === "dynamic-options" && schema.options) {
    return <DynamicOptionsField key={props.path} {...props} />;
  }

  // location → LocationField (country → region → city cascade; Brazil gets a map)
  if (schema.format === "location") {
    return <LocationField key={props.path} {...props} />;
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
  sandbox,
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
  sandbox?: FieldProps["sandbox"];
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

  if (keys.length === 0) {
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

  const activeKey =
    breadcrumbPath.length > 0
      ? resolveActiveFieldKey(keys, properties, objValue, breadcrumbPath)
      : null;
  const activeSchema = activeKey ? properties[activeKey] : null;
  const visibleKeys = activeKey && activeSchema ? [activeKey] : keys;
  const fieldBreadcrumbPath =
    activeKey && activeSchema
      ? breadcrumbPathForActiveField(activeKey, activeSchema, breadcrumbPath)
      : breadcrumbPath;
  return (
    <div className="min-w-0 space-y-6">
      {visibleKeys.map((key) => {
        const propSchema = properties[key];
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
          sandbox,
        });
      })}
    </div>
  );
}
