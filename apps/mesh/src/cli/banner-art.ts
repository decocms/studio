/**
 * Single source of truth for the DECO ASCII banner.
 *
 * Pure (no Ink) so both the plain `--no-tui` path and the server startup
 * banner can import it without pulling React/Ink into their bundles. The
 * Ink `<Banner>` component (banner.tsx) consumes BANNER_LINES/BANNER_GRADIENT.
 */

export const BANNER_LINES = [
  " ██████████   ██████████   █████████     ███████   ",
  "░░███░░░░███ ░░███░░░░░█  ███░░░░░███  ███░░░░░███ ",
  " ░███   ░░███ ░███  █ ░  ███     ░░░  ███     ░░███",
  " ░███    ░███ ░██████   ░███         ░███      ░███",
  " ░███    ░███ ░███░░█   ░███         ░███      ░███",
  " ░███    ███  ░███ ░   █░░███     ███░░███     ███ ",
  " ██████████   ██████████ ░░█████████  ░░░███████░  ",
  "░░░░░░░░░░   ░░░░░░░░░░   ░░░░░░░░░     ░░░░░░░   ",
];

export const BANNER_GRADIENT = [
  "#00ff64",
  "#00ee5e",
  "#00dc56",
  "#00c84e",
  "#00b444",
  "#00a03c",
  "#008832",
  "#006e28",
];

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * The banner as an array of ANSI-colored strings. Pass `version` to append
 * a dimmed ` v<version>` line; omit it for the bare art.
 */
export function bannerLines(version?: string): string[] {
  const out = BANNER_LINES.map((line, i) => {
    const [r, g, b] = hexToRgb(BANNER_GRADIENT[i]!);
    return `\x1b[38;2;${r};${g};${b}m${line}\x1b[39m`;
  });
  if (version !== undefined) {
    out.push(`\x1b[2m  v${version}\x1b[22m`);
  }
  return out;
}

/** Print the banner to stdout, padded with blank lines (plain / --no-tui path). */
export function printBanner(version: string): void {
  console.log("");
  for (const line of bannerLines(version)) console.log(line);
  console.log("");
}
