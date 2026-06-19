import type { LiveMeta, SchemaProperty } from "../resolve-schema";
import type { SectionCatalogEntry } from "../section-catalog";

export interface FieldProps {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
  label: string;
  breadcrumbPath?: string[];
  onBreadcrumbChange?: (path: string[]) => void;
  meta?: LiveMeta;
  decofile?: Record<string, unknown>;
  containerResolveType?: string;
  previewBaseUrl?: string | null;
  onAddSectionItem?: (
    entry: SectionCatalogEntry,
    append: (item: unknown) => void,
  ) => void | Promise<void>;
  onSaveReferencedBlock?: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
}
