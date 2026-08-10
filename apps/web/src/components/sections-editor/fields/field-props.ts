import type { LiveMeta, SchemaProperty } from "../resolve-schema";
import type { Crumb } from "../schema-form-breadcrumb";
import type { SectionCatalogEntry } from "../section-catalog";

export interface SandboxConfig {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string;
  siteSlug?: string | null;
}

export interface FieldProps {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
  label: string;
  breadcrumbPath?: Crumb[];
  onBreadcrumbChange?: (path: Crumb[]) => void;
  /**
   * True when this field shares its object scope with another array/drill-down
   * field. Array fields use it to decide whether their own label must stay in
   * the breadcrumb: a bare `[itemLabel]` trail can't say WHICH sibling array an
   * item belongs to (two label-less arrays both fall back to "Item N"), so when
   * siblings exist the array label is kept as a disambiguator.
   */
  hasSiblingDrillDownFields?: boolean;
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
