export interface DomainRow {
  name: string;
  owner: string;
}

// A domain name becomes a path component, a git branch segment, a gh label,
// and a launchd-adjacent string — keep it to a safe charset.
export function isValidDomainName(name: string): boolean {
  return /^[a-z0-9_-]+$/i.test(name);
}

// Parses DOMAINS.md table rows: | [name](./name/DOMAIN.md) | `paths` | @owner |
// Owner is anchored to the LAST cell so pipes inside the paths cell can't
// shift columns. Rows with invalid domain names are skipped with a warning —
// a silently-empty result would make `tick` a no-op with no signal.
export function parseDomains(markdown: string): DomainRow[] {
  const rows: DomainRow[] = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(
      /^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|.*\|\s*@?([\w-]+)\s*\|\s*$/,
    );
    const [, name, owner] = m ?? [];
    if (!name || !owner) continue;
    if (!isValidDomainName(name)) {
      console.error(`skipping invalid domain name in DOMAINS.md: "${name}"`);
      continue;
    }
    rows.push({ name, owner });
  }
  return rows;
}
