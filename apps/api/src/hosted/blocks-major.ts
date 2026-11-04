/**
 * The project's Blocks v8 marker, `metadata.blocksMajor: 8`, is set only by
 * `deco schema push` (`PUT /api/:org/cms/:site/schema`, through
 * `syncBlocksMajorMarker` in `blocks-major-marker.ts`) from the schema it
 * pushed. No code reads git to compute it: a new thread's default runtime
 * (`defaultThreadRuntime`) and Studio's editor and hosted screens read the
 * stored marker as it is.
 */

/** The site's folder inside the repo (`metadata.runtime.path`), or null. */
export function projectPackagePath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  return runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
}
