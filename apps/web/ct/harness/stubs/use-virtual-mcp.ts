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
 * `SecretField` encrypts through the site at `previewServerUrl`; specs
 * intercept {@link CT_SITE_URL} with `page.route`.
 *
 * Only the export actually imported by the fields is provided.
 */
export const CT_SITE_URL = "https://secret-site.test/";

export function useVirtualMCP(): {
  metadata: { fieldDescriptionTooltips: true; previewServerUrl: string };
} {
  return {
    metadata: { fieldDescriptionTooltips: true, previewServerUrl: CT_SITE_URL },
  };
}
