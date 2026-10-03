/**
 * Stub for `@/components/markdown-editor/use-file-upload`: the real one PUTs to
 * the org filesystem through `useProjectContext()`, which a bare mount lacks.
 */
export function useEditorFileUpload() {
  return { uploadFile: async (): Promise<string | null> => null };
}
