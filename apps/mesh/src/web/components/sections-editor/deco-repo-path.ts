/**
 * Join a virtual MCP's package path (`metadata.runtime.path`, e.g.
 * "eitri-shopping-monte-carlo-shared") with a repo-relative `.deco/*` path.
 *
 * The sandbox daemon resolves file reads against the repo root, but when the
 * project doesn't live at the repo root the dev server runs with the package
 * path as its cwd — so the committed `.deco/*.gen.json` artifacts sit under it
 * (`<packagePath>/.deco/blocks.gen.json`). The live `/.decofile` + `/live/_meta`
 * routes already resolve relative to that cwd; only the committed-snapshot reads
 * need the prefix. An empty/absent package path means the repo root.
 */
export function decoRepoPath(
  packagePath: string | null | undefined,
  relative: string,
): string {
  const base = (packagePath ?? "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
  return base ? `${base}/${relative}` : relative;
}
