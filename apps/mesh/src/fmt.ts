/**
 * Shared ANSI formatting helpers for CLI output.
 *
 * Every startup log (cli.ts, env.ts, index.ts) imports from here
 * so that the visual style stays consistent.
 */

export const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
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

export const ASCII_ART = [
  green("       _                    ____ __  __ ____"),
  green("    __| | ___  ___ ___     / ___|  \\/  / ___|"),
  green("   / _` |/ _ \\/ __/ _ \\   | |   | |\\/| \\___ \\"),
  green("  | (_| |  __/ (_| (_) |  | |___| |  | |___) |"),
  green("   \\__,_|\\___|\\___\\___/    \\____|_|  |_|____/"),
];
