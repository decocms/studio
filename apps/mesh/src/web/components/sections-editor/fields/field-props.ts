import type { SchemaProperty } from "../resolve-schema";

export interface FieldProps {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
  label: string;
  breadcrumbPath?: string[];
  onBreadcrumbChange?: (path: string[]) => void;
}
