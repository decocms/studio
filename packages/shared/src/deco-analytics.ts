/**
 * A site deco doesn't host keeps its Deco Analytics registration on its
 * project, under `metadata.decoAnalytics`. ANALYTICS_INSTALL writes it after
 * creating the registration for that org, and only the server writes it
 * (`stripServerManagedMetadata`), so the id is one that org may read: the API
 * reads it to scope analytics data, the web app to offer the Analytics view.
 */

import { z } from "zod";

export const DECO_ANALYTICS_METADATA_KEY = "decoAnalytics";

const ExternalRegistration = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
});

/** The registration stored on a project's metadata, or null. */
export function storedExternalRegistration(
  metadata: unknown,
): { id: string; key: string } | null {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !(DECO_ANALYTICS_METADATA_KEY in metadata)
  ) {
    return null;
  }
  const parsed = ExternalRegistration.safeParse(
    metadata[DECO_ANALYTICS_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}
