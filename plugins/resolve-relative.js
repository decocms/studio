/**
 * Resolve `../` / `./` segments of a relative import specifier against the
 * importing file's path.
 *
 * Used by ban-web-server-imports.js and ban-git-provider-reachthrough.js to
 * check if a relative import reaches into a forbidden tree.
 */
export function resolveRelative(fromFile, spec) {
  const parts = fromFile.split("/");
  parts.pop(); // drop the filename → containing directory
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
