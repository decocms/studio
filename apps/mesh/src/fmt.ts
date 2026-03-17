/**
 * Shared ANSI formatting helpers for CLI output.
 *
 * Every startup log (cli.ts, env.ts, index.ts) imports from here
 * so that the visual style stays consistent.
 */

export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
export const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
export const underline = (s: string) => `\x1b[4m${s}\x1b[24m`;

export const KEY_WIDTH = 32;
export const RULE_WIDTH = 42;

export function section(title: string): string {
  return `\n  ${dim(`── ${title} ${"─".repeat(Math.max(0, RULE_WIDTH - title.length - 4))}`)}`;
}

export function row(key: string, value: string): string {
  return `  ${dim(key.padEnd(KEY_WIDTH))}${value}`;
}

const rgb = (r: number, g: number, b: number, s: string) =>
  `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;

export const ASCII_ART = [
  rgb(0, 255, 100, "  ██████╗ ███████╗ ██████╗ ██████╗ "),
  rgb(
    0,
    230,
    90,
    "  ██╔══██╗██╔════╝██╔════╝██╔═══██╗   ██████╗███╗   ███╗███████╗",
  ),
  rgb(
    0,
    200,
    80,
    "  ██║  ██║█████╗  ██║     ██║   ██║  ██╔════╝████╗ ████║██╔════╝",
  ),
  rgb(
    0,
    170,
    65,
    "  ██║  ██║██╔══╝  ██║     ██║   ██║  ██║     ██╔████╔██║███████╗",
  ),
  rgb(
    0,
    140,
    50,
    "  ██████╔╝███████╗╚██████╗╚██████╔╝  ╚██████╗██║╚██╔╝██║╚════██║",
  ),
  rgb(
    0,
    110,
    40,
    "  ╚═════╝ ╚══════╝ ╚═════╝ ╚═════╝   ╚═════╝╚═╝ ╚═╝ ╚═╝███████║",
  ),
];
