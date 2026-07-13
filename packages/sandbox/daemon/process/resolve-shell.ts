import { existsSync } from "node:fs";
// Always win32 path semantics here — the candidates we build are Windows
// paths regardless of the host OS running this code (tests inject win32
// paths via `deps` while running on macOS/Linux CI; `node:path`'s default
// export is POSIX-flavored there and would silently mis-split backslash
// paths).
import { dirname, join } from "node:path/win32";
import { execFileSync } from "node:child_process";
import { ShellNotFoundError } from "./structured-command";

interface ResolveShellDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  /**
   * Returns the raw `where git` stdout (may contain multiple `\r\n`-joined
   * matches — PATH can list more than one git.exe, e.g. a scoop/hostedtoolcache
   * shim ahead of the real Git for Windows install). Tests may inject a
   * single bare path (no newline) — that's just the one-line case.
   */
  whichGit?: () => string | null;
}

function defaultWhichGit(): string | null {
  try {
    return execFileSync("where", ["git"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** Well-known default install location — tried last, even when `where git`
 *  found nothing or resolved to paths that don't hold bash.exe. Covers the
 *  common case of Git for Windows installed at the default path but PATH
 *  not yet refreshed in the daemon's process environment. */
const WELL_KNOWN_DEFAULT = "C:\\Program Files\\Git\\bin\\bash.exe";

/**
 * The shell used for USER-owned commands (start script, /exec, /bash).
 * Daemon-owned steps never call this — they are StructuredCommands.
 * win32: Git Bash, resolved from the git install (git is already a hard
 * product prerequisite). DECO_SHELL overrides. Cached per process — the
 * resolution result can't change without a daemon restart.
 */
let cached: Record<string, string> | undefined;
export function resolveShell(
  kind: "sh" | "bash",
  deps: ResolveShellDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return kind;
  const injected = deps.platform !== undefined || deps.env !== undefined;
  if (!injected && cached?.[kind]) return cached[kind];

  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const whichGit = deps.whichGit ?? defaultWhichGit;

  const candidates: string[] = [];
  if (env.DECO_SHELL) candidates.push(env.DECO_SHELL);

  const gitOutput = whichGit();
  const gitPaths = gitOutput
    ? gitOutput
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    : [];
  for (const gitPath of gitPaths) {
    // `where git` may resolve through very different install shapes:
    //   <root>\cmd\git.exe          (standard Git for Windows install → 2 levels up)
    //   <root>\mingw64\bin\git.exe  (mingw64-shaped / some CI images → 3 levels up)
    // Try both ancestor depths for every match rather than guessing which
    // shape produced it.
    const ancestor2 = dirname(dirname(gitPath));
    const ancestor3 = dirname(dirname(dirname(gitPath)));
    for (const root of [ancestor2, ancestor3]) {
      candidates.push(join(root, "bin", "bash.exe"));
      candidates.push(join(root, "usr", "bin", "bash.exe"));
    }
  }
  candidates.push(WELL_KNOWN_DEFAULT);

  const found = candidates.find((c) => exists(c));
  if (!found) {
    // Next CI run should tell us exactly what the runner sees instead of
    // just "not found" — log the git path(s) `where git` reported and every
    // candidate we tried before giving up.
    console.warn(
      `[resolveShell] no ${kind} shell found — git path(s): ${
        gitPaths.length > 0
          ? gitPaths.join(", ")
          : "(none — where git found nothing)"
      }; candidates tried: ${candidates.join(", ")}`,
    );
    throw new ShellNotFoundError();
  }
  if (!injected) cached = { ...cached, [kind]: found };
  return found;
}
