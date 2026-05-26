import type { SchemaProperty } from "./resolve-schema";
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

/** Skip internal deco properties that shouldn't be user-editable. */
const HIDDEN_PROPS = new Set(["__resolveType", "@type"]);

/**
 * Detect image-typed string fields when the JSON Schema doesn't carry an
 * explicit `format: "image-uri"`. Deco section authors frequently leave the
 * type as plain `string` and just name the field something like `image` or
 * `logo`; this fallback gives those fields the picker UX too.
 */
const IMAGE_NAME =
  /^(image|img|picture|photo|thumbnail|thumb|avatar|logo|banner|cover|hero|icon)s?$/i;
const IMAGE_NAME_SUFFIX =
  /(image|img|picture|photo|thumbnail|avatar|logo|banner|icon|cover|hero)(url|src|uri|href)?$/i;

function isLikelyImageField(schema: SchemaProperty, path: string): boolean {
  if (schema.format === "image-uri") return true;
  if (schema.type !== "string" || schema.enum) return false;
  const key = path.split(".").pop() ?? "";
  if (!key) return false;
  return IMAGE_NAME.test(key) || IMAGE_NAME_SUFFIX.test(key);
}

function isLikelyFileField(schema: SchemaProperty, path: string): boolean {
  if (schema.format === "file-uri") return true;
  if (schema.type !== "string" || schema.enum) return false;
  const key = path.split(".").pop() ?? "";
  return /^(file|document|attachment|asset|media|video|audio|pdf)s?$/i.test(
    key,
  );
}

function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
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

  // Block-ref field (loader/section selector with anyOfRefs)
  if (
    schema.type === "block-ref" ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).__resolveType === "string" &&
      schema.anyOfRefs)
  ) {
    // For now render as object if we have properties, otherwise skip
    if (schema.anyOfRefs) {
      return <AnyOfField key={props.path} {...props} />;
    }
    return null;
  }

  // Image fields: explicit `format: "image-uri"` or a name that strongly
  // suggests an image (image/logo/avatar/banner/…).
  if (isLikelyImageField(schema, props.path)) {
    return <ImageField key={props.path} {...props} />;
  }
  // File fields: explicit `format: "file-uri"` or a generic file/attachment name.
  if (isLikelyFileField(schema, props.path)) {
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

  // If value is null/undefined, try to produce a typed default from schema
  const effectiveValue =
    value === null || value === undefined
      ? defaultForType(schema.type, schema.default)
      : value;

  if (effectiveValue === null || effectiveValue === undefined) return null;

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
}: {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  basePath: string;
  breadcrumbPath?: string[];
  onBreadcrumbChange?: (path: string[]) => void;
}) {
  const properties = schema.properties;
  if (!properties) return null;

  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const keys = Object.keys(properties).filter((k) => !HIDDEN_PROPS.has(k));

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

  return (
    <div className="min-w-0 space-y-6">
      {keys.map((key) => {
        const propSchema = properties[key];
        if (!propSchema) return null;
        const fieldPath = basePath ? `${basePath}.${key}` : key;
        const label = propSchema.title ?? humanize(key);

        return renderField({
          schema: propSchema,
          value: objValue[key],
          onChange: (val) => updateField(key, val),
          path: fieldPath,
          label,
          breadcrumbPath,
          onBreadcrumbChange,
        });
      })}
    </div>
  );
}
