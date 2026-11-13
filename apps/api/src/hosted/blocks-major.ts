/**
 * Where a hosted project's site lives in its repository. Whether a project
 * is Blocks v8 is its "Blocks v8 site" switch (`isBlocksV8Project` in
 * `@decocms/shared/blocks-major`), which only an org admin sets: no code
 * here, and no `deco schema push`, derives it.
 */

/** The site's folder inside the repo (`metadata.runtime.path`), or null. */
export function projectPackagePath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  return runtime?.path?.replace(/^\/+|\/+$/g, "") || null;
}
