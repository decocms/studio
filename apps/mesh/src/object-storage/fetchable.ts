/** Reject a URL that cannot be fetched by a remote daemon (e.g. a DevObjectStorage
 *  inline `data:` URL). Used by the offload path's `requireFetchable` presign. */
export function assertFetchableUrl(url: string): string {
  if (url.startsWith("data:")) {
    throw new Error(
      "object storage returned a not fetchable (data:) URL; configure real S3/R2/MinIO for large-payload offload",
    );
  }
  return url;
}
