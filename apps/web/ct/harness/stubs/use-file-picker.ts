/**
 * CT stub for `@/hooks/use-file-picker`.
 *
 * The real hook uploads a File through the org-scoped proxy to S3. In
 * component tests there is no backend; we return a resolved mutation so the
 * upload code path is inert. The real upload is covered (or deferred to) e2e.
 *
 * Only `useFilePickerUpload` is consumed by image-field/file-field.
 */
export function useFilePickerUpload() {
  return {
    isPending: false,
    mutateAsync: async (_input: { configId: string; file: File }) => ({
      publicUrl: "https://cdn.example.com/ct-uploaded.png",
    }),
  };
}
