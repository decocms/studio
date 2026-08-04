/**
 * CT stub for `@/hooks/use-organization-settings`.
 *
 * The real hook calls `useProjectContext()`, which needs the full app
 * provider tree (ProjectContextProvider) that this harness doesn't mount.
 * `FieldLabel` (used by nearly every field widget) reads `useOrgFlag(
 * "field_description_tooltips")` to choose between the tooltip and inline
 * description layouts — the flag is opt-in (unset/false = inline, the
 * default), but the tooltip layout is the one under test here, so this
 * always returns `true`.
 *
 * Only the export actually imported by field-label.tsx is provided.
 */
export function useOrgFlag(): boolean {
  return true;
}
