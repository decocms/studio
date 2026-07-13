import { delimiter } from "node:path";

/**
 * A child-process command as argv + env + cwd — no shell interprets it, on
 * any platform. This is the ONLY representation daemon-owned steps (clone/
 * install/corepack/checkout) may use: shell strings are reserved for
 * user-owned commands (start script, /exec, /bash), which go through
 * resolveShell(). See docs/superpowers/specs/2026-07-13-daemon-windows-support-design.md.
 */
export interface StructuredCommand {
  /** argv[0] is resolved via PATH by the OS spawn. Must be non-empty. */
  argv: readonly string[];
  /** Merged over process.env by the spawn layer. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}

/** Thrown when no shell can run a string command on this platform. */
export class ShellNotFoundError extends Error {
  constructor() {
    super(
      "POSIX shell (sh) not found — string commands need a shell. " +
        "On Windows: install Git for Windows (ships bash) or run the daemon under WSL2.",
    );
    this.name = "ShellNotFoundError";
  }
}

export function isStructuredCommand(x: unknown): x is StructuredCommand {
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray((x as StructuredCommand).argv) &&
    (x as StructuredCommand).argv.length > 0
  );
}

/**
 * PATH prepend that works on both platforms (`;` on win32, `:` elsewhere).
 * Returns {} when there is nothing to prepend so callers can spread it
 * without clobbering PATH.
 */
export function withPathDirs(
  dirs: readonly string[],
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (dirs.length === 0) return {};
  const base = baseEnv.PATH;
  return {
    PATH: base
      ? `${dirs.join(delimiter)}${delimiter}${base}`
      : dirs.join(delimiter),
  };
}

/** Human-readable form for `$ …` log lines. Quotes args containing spaces (display only — not shell-safe escaping, none needed). */
export function formatCommand(cmd: string | StructuredCommand): string {
  if (typeof cmd === "string") return cmd;
  return cmd.argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}
