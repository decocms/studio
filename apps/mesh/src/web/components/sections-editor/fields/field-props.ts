import type { LiveMeta, SchemaProperty } from "../resolve-schema";
import type { SectionCatalogEntry } from "../section-catalog";

export interface SandboxConfig {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string;
}

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
  onRequestAddSection?: (context: { append: (item: unknown) => void }) => void;
  onSaveReferencedBlock?: (
    blockKey: string,
    data: Record<string, unknown>,
  ) => void;
  sandbox?: SandboxConfig | null;
}
