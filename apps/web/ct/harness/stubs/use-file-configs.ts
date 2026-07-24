/**
 * CT stub for `@/hooks/use-file-configs`.
 *
 * The real hook calls the FILE_CONFIG_LIST MCP tool via @/sdk,
 * which needs the full app provider tree (ProjectContext + MCP client) and a
 * live backend. In component tests we only exercise the field's own
 * render/paste/remove logic, so we return a fixed shape. Zero configs means
 * "drop-on-field" defers to the picker dialog (also stubbed), which is exactly
 * the deterministic path we want under test.
 *
 * Only the exports actually imported by image-field/file-field are provided.
 */
export function useFileConfigsQuery() {
  return {
    data: { configs: [] as Array<{ id: string }> },
    isPending: false,
    isError: false,
  };
}
