/**
 * Shared ANSI formatting helpers for CLI output.
 *
 * Every startup log (cli.ts, index.ts) imports from here
 * so that the visual style stays consistent.
 */

export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

const rgb = (r: number, g: number, b: number, s: string) =>
  `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;

export const ASCII_ART = [
  rgb(0, 255, 100, " ██████████   ██████████   █████████     ███████   "),
  rgb(0, 238, 94, "░░███░░░░███ ░░███░░░░░█  ███░░░░░███  ███░░░░░███ "),
  rgb(0, 220, 86, " ░███   ░░███ ░███  █ ░  ███     ░░░  ███     ░░███"),
  rgb(0, 200, 78, " ░███    ░███ ░██████   ░███         ░███      ░███"),
  rgb(0, 180, 68, " ░███    ░███ ░███░░█   ░███         ░███      ░███"),
  rgb(0, 160, 60, " ░███    ███  ░███ ░   █░░███     ███░░███     ███ "),
  rgb(0, 136, 50, " ██████████   ██████████ ░░█████████  ░░░███████░  "),
  rgb(0, 110, 40, "░░░░░░░░░░   ░░░░░░░░░░   ░░░░░░░░░     ░░░░░░░   "),
];
