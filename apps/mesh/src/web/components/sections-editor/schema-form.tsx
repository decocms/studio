import type { SchemaProperty } from "./resolve-schema";
import type { FieldProps } from "./fields/field-props";
import { StringField } from "./fields/string-field";
import { NumberField } from "./fields/number-field";
import { BooleanField } from "./fields/boolean-field";
import { EnumField } from "./fields/enum-field";
import { ArrayField } from "./fields/array-field";
import { ObjectField } from "./fields/object-field";
import { AnyOfField } from "./fields/any-of-field";
import { ImageField } from "./fields/image-field";

/** Skip internal deco properties that shouldn't be user-editable. */
const HIDDEN_PROPS = new Set(["__resolveType"]);

const IMAGE_FORMATS = new Set(["image-uri", "file-uri"]);

export function renderField(props: FieldProps) {
  const { schema } = props;

  // Image format
  if (schema.format && IMAGE_FORMATS.has(schema.format)) {
    return <ImageField key={props.path} {...props} />;
  }

  // Enum
  if (schema.enum && schema.enum.length > 0) {
    return <EnumField key={props.path} {...props} />;
  }

  // anyOf
  if (schema.type === "anyOf" || (schema.anyOf && schema.anyOf.length > 0)) {
    return <AnyOfField key={props.path} {...props} />;
  }

  switch (schema.type) {
    case "string":
      return <StringField key={props.path} {...props} />;
    case "number":
    case "integer":
      return <NumberField key={props.path} {...props} />;
    case "boolean":
      return <BooleanField key={props.path} {...props} />;
    case "array":
      return <ArrayField key={props.path} {...props} />;
    case "object":
      if (schema.properties) {
        return <ObjectField key={props.path} {...props} />;
      }
      return null;
    default:
      // Unknown type — render as string input
      return <StringField key={props.path} {...props} />;
  }
}

export function SchemaForm({
  schema,
  value,
  onChange,
  basePath,
}: {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  basePath: string;
}) {
  const properties = schema.properties;
  if (!properties) return null;

  const objValue =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const updateField = (key: string, fieldValue: unknown) => {
    onChange({ ...objValue, [key]: fieldValue });
  };

  return (
    <div className="space-y-4">
      {Object.entries(properties).map(([key, propSchema]) => {
        if (HIDDEN_PROPS.has(key)) return null;

        const fieldPath = basePath ? `${basePath}.${key}` : key;
        const label = propSchema.title ?? key;

        return renderField({
          schema: propSchema,
          value: objValue[key],
          onChange: (val) => updateField(key, val),
          path: fieldPath,
          label,
        });
      })}
    </div>
  );
}
