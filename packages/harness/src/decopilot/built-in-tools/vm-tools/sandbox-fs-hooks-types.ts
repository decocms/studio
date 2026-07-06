/**
 * Harness-owned filesystem-hook contract (option-b sandbox decoupling).
 *
 * MIRROR of the shape exported by
 * `packages/sandbox/server/provider/sandbox-fs-hooks.ts` (the `SandboxFsHooks` +
 * payload interfaces). `createSandboxFsHooks(provider, lifecycle)` over there
 * returns a value that stays STRUCTURALLY assignable to this interface, so the
 * portable harness VM tools consume the flat hooks WITHOUT importing
 * `@decocms/sandbox` — which would re-introduce the harness→sandbox cycle the
 * package extraction is breaking (spec 2026-06-11-harness-extraction-design.md
 * §4.3).
 *
 * The two definitions MUST stay structurally identical until the package move
 * (spec Phase 5) collapses them to one. `tsc` enforces this at the glue seams
 * (`cluster-sandbox-fs.ts` / `desktop-sandbox-fs.ts`, which annotate their
 * return as this type while calling the sandbox builder) plus a compile-time
 * drift assertion in `sandbox-fs-hooks-types.test.ts`.
 */

export interface SandboxFsEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface SandboxFsBashOpts {
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxFsBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxFsGrepOpts {
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
}

export interface SandboxFsGrepHit {
  file: string;
  line: number;
  text: string;
}

export interface SandboxFsHooks {
  onRead(path: string): Promise<string>;
  onWrite(path: string, content: string): Promise<void>;
  onEdit(path: string, edits: SandboxFsEdit[]): Promise<void>;
  onBash(cmd: string, opts?: SandboxFsBashOpts): Promise<SandboxFsBashResult>;
  onGlob(pattern: string): Promise<string[]>;
  onGrep(
    pattern: string,
    opts?: SandboxFsGrepOpts,
  ): Promise<SandboxFsGrepHit[]>;
  /**
   * Escape hatch — proxy an arbitrary `/_sandbox/*` daemon route and return its
   * parsed JSON body, sharing the flat ops' handle-resolution + auto-restart
   * retry layer. Used by the richer LLM-visible tools to cover daemon surfaces
   * the typed flat ops intentionally don't model (image reads, html-buffer
   * preview shapes, copy_to_sandbox/share_with_user transfer routes).
   *
   * `signal` is the run's abort signal (AI-SDK `ToolCallOptions.abortSignal`):
   * cancelling the run aborts the in-flight daemon request.
   */
  onProxy(
    path: string,
    body: Record<string, unknown>,
    method?: "POST" | "PUT",
    signal?: AbortSignal,
  ): Promise<unknown>;
}
