/**
 * CT stub for `@/sdk/hooks/use-virtual-mcp`.
 *
 * The real hook calls `useProjectContext()`, which needs the full app
 * provider tree (ProjectContextProvider) that this harness doesn't mount.
 * `FieldLabel` (used by nearly every field widget) reads
 * `useVirtualMCP(virtualMcpId)?.metadata?.fieldDescriptionTooltips` to
 * choose between the tooltip and inline description layouts — the setting
 * is opt-in (unset/false = inline, the default), but the tooltip layout is
 * the one under test here, so this always reports it enabled.
 *
 * Only the export actually imported by field-label.tsx is provided.
 */
export function useVirtualMCP(): {
  metadata: { fieldDescriptionTooltips: true };
} {
  return { metadata: { fieldDescriptionTooltips: true } };
}
