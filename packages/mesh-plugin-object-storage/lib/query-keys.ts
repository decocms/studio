/**
 * React Query keys for Object Storage plugin
 */

export const KEYS = {
  objects: (
    connectionId: string,
    prefix: string,
    flat: boolean = false,
    pageSize: number = 100,
  ) =>
    [
      "object-storage",
      "objects",
      connectionId,
      prefix,
      { flat, pageSize },
    ] as const,
  metadata: (connectionId: string, key: string) =>
    ["object-storage", "metadata", connectionId, key] as const,
  imagePreview: (connectionId: string, key: string) =>
    ["object-storage", "image-preview", connectionId, key] as const,
  fileContent: (connectionId: string, key: string) =>
    ["object-storage", "file-content", connectionId, key] as const,
} as const;
