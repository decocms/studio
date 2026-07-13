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
  whichGit?: () => string | null;
}

function defaultWhichGit(): string | null {
  try {
    const out = execFileSync("where", ["git"], { encoding: "utf8" });
    return (
      out
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0)
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

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
  const gitPath = whichGit();
  if (gitPath) {
    const root = dirname(dirname(gitPath)); // <root>\cmd\git.exe → <root>
    candidates.push(join(root, "bin", "bash.exe"));
    candidates.push(join(root, "usr", "bin", "bash.exe"));
  }
  const found = candidates.find((c) => exists(c));
  if (!found) throw new ShellNotFoundError();
  if (!injected) cached = { ...cached, [kind]: found };
  return found;
}
