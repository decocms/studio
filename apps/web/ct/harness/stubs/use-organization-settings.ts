/**
 * CT stub for `@/hooks/use-organization-settings`.
 *
 * The real hook calls `useProjectContext()`, which needs the full app
 * provider tree (ProjectContextProvider) that this harness doesn't mount.
 * `FieldLabel` (used by nearly every field widget) reads `useOrgFlag(
 * "inline_field_descriptions")` to choose between the tooltip and inline
 * description layouts — component tests exercise the tooltip layout (the
 * default, unset-flag behavior), so this always returns `false`.
 *
 * Only the export actually imported by field-label.tsx is provided.
 */
export function useOrgFlag(): boolean {
  return false;
}
