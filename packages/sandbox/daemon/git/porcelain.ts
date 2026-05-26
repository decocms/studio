/** Parse one `git status --porcelain=v1 -z` entry into status chars + path. */
export function parsePorcelainEntry(
  entry: string,
): { index: string; working: string; path: string } | null {
  if (entry.length < 3) return null;
  const index = entry[0] ?? " ";
  const working = entry[1] ?? " ";
  // Standard v1: "XY filename". Some `-z` outputs omit the separator space.
  const path =
    entry.length >= 4 && entry[2] === " " ? entry.slice(3) : entry.slice(2);
  if (!path) return null;
  return { index, working, path };
}

/** Parse full `-z` porcelain output into a set of changed paths. */
export function parsePorcelainZ(out: string): Set<string> {
  const paths = new Set<string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const parsed = parsePorcelainEntry(entry);
    if (!parsed) continue;
    paths.add(parsed.path);
    if (parsed.index === "R" || parsed.index === "C") {
      i++;
      const orig = parts[i];
      if (orig) paths.add(orig);
    }
  }
  return paths;
}
