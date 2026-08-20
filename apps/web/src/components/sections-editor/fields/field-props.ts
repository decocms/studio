import type { LiveMeta, SchemaProperty } from "../resolve-schema";
import type { Crumb } from "../schema-form-breadcrumb";
import type { SectionCatalogEntry } from "../section-catalog";

export interface SandboxConfig {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** The session rendering the field; `null` only for a thread-less surface. */
  threadId: string | null;
  previewUrl?: string;
  siteSlug?: string | null;
}

export interface FieldProps {
  schema: SchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
  label: string;
  /**
   * Whether the parent object marks this field as required. Optional fields
   * (the default when omitted) let widgets offer a way to clear the value —
   * e.g. `EnumField` shows a "None" option so an optional select can be left
   * empty.
   */
  required?: boolean;
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
  /**
   * True when this field is the sole field its parent narrowed to for the active
   * breadcrumb (i.e. the form is drilled into it). Object fields use it to render
   * their contents flat — no collapsible header, no indentation — since the
   * breadcrumb already conveys the location, so drilling into a deeply nested
   * item shows just the item's fields instead of a stack of wrapper headers.
   */
  focused?: boolean;
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
