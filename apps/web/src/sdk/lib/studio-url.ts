interface StudioUrlOptions {
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
}

/**
 * Resolve the Studio origin from the preferred option, its legacy alias, or a
 * caller-provided fallback.
 */
export function resolveStudioUrl(
  options: StudioUrlOptions,
  fallback: string,
): string;
export function resolveStudioUrl(
  options: StudioUrlOptions,
  fallback?: string,
): string | undefined;
export function resolveStudioUrl(
  { studioUrl, meshUrl }: StudioUrlOptions,
  fallback?: string,
): string | undefined {
  return studioUrl ?? meshUrl ?? fallback;
}
