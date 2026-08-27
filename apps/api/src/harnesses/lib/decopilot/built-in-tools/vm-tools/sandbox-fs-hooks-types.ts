/**
 * Harness-side mirror of the daemon hooks exported by `@decocms/sandbox`.
 * Keeping the small structural contract here prevents the portable VM tools
 * from importing the sandbox package and recreating an app/package cycle.
 */

export interface SandboxFsBashOpts {
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxFsBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxFsHooks {
  onBash(cmd: string, opts?: SandboxFsBashOpts): Promise<SandboxFsBashResult>;
  /**
   * Proxy a `/_sandbox/*` daemon route and return its parsed JSON body, sharing
   * `onBash`'s handle-resolution and restart behavior.
   *
   * `signal` is the run's abort signal (AI-SDK `ToolCallOptions.abortSignal`):
   * cancelling the run aborts the in-flight daemon request.
   */
  onProxy(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
