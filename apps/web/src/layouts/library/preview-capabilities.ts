export interface LibraryPreviewCapabilities {
  canEditHtml: boolean;
  canShare: boolean;
}

/** Keep the shared Library preview read-only when it is embedded in a thread. */
export function resolveLibraryPreviewCapabilities(
  readOnly: boolean,
  volume: string | null,
): LibraryPreviewCapabilities {
  return {
    canEditHtml: !readOnly && volume === "home",
    canShare: !readOnly,
  };
}
