/**
 * The argv/env equivalents of the old `gc` shell prefix
 * (`GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git -c safe.directory='*' …`).
 * Argv form means no quoting layer exists: `safe.directory=*` needs no
 * single quotes, and repo paths with spaces/backslashes pass through
 * untouched on every platform.
 */
export function gitBaseArgv(): string[] {
  return [
    "git",
    "-c",
    "safe.directory=*",
    "-c",
    "credential.helper=",
    "-c",
    "http.connectTimeout=10",
    "-c",
    "http.lowSpeedLimit=1",
    "-c",
    "http.lowSpeedTime=10",
  ];
}

/**
 * GIT_TERMINAL_PROMPT=0 + a real no-op GIT_ASKPASS program: the PTY makes
 * git think it has a terminal, so a private repo without credentials would
 * hang on a prompt instead of failing fast. The old `GIT_ASKPASS=true`
 * relied on a `true` binary existing — materializeAskpass provides the
 * cross-platform equivalent.
 */
export function gitStepEnv(askpassPath: string): Record<string, string> {
  return { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpassPath };
}
