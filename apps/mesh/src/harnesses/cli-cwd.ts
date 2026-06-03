/**
 * Shared working-directory resolver for CLI harnesses (Claude Code, Codex).
 *
 * The two CLI harnesses spawn third-party subprocesses (`claude`, `codex`)
 * that need to run inside the user's checkout — not wherever the host
 * process happens to be. Both used to compute this independently and the
 * codex harness simply never did, leaving its subprocess in the daemon's
 * own cwd (typically the app root, not the cloned repo). This module is
 * the single source of truth so the two CLIs stay in lockstep.
 *
 * Resolution rules (mirrors the cluster's pre-extraction
 * `resolveClaudeCodeCwd`):
 *
 *   1. **Ephemeral agent** (no `virtualMcp.metadata.githubRepo`): return
 *      `undefined`. There's no on-disk checkout to point at, so let the
 *      SDK fall through to its own default (which in turn defaults to
 *      `process.cwd()` for both providers).
 *   2. **No authenticated user**: return `undefined`. Defensive — every
 *      real request has a `user.id`, but the harness types allow the
 *      absence and we'd rather skip than crash.
 *   3. **Desktop daemon path** (`processLocal` is absent): the sandbox
 *      daemon (`packages/sandbox/daemon/entry.ts`) spawns this process
 *      with `cwd = <appRoot>` and clones the repo into `<appRoot>/repo`.
 *      Prefer the env vars the sandbox sets (`WORKDIR` then `APP_ROOT`),
 *      then fall back to `process.cwd()`. Append `/repo` in every case so
 *      the CLI actually runs inside the checkout.
 *   4. **Cluster path** (`processLocal` is set): defer to the optional
 *      `processLocal.resolveCwd` callback. The cluster used to inject a
 *      `host` runner that materialized files at a per-branch path; that
 *      runner has been retired and the cluster no longer supplies a
 *      resolver, so we fall through to `undefined`. The callback is kept
 *      as an extension point for future cluster-side runners.
 */

import type { HarnessStreamInput } from "./types";

/**
 * Compute the CLI subprocess working directory for a harness call.
 *
 * Returns `undefined` to mean "let the SDK pick its own default" — both
 * `ai-sdk-provider-claude-code` and `ai-sdk-provider-codex-cli` then use
 * `process.cwd()` internally, which is fine for non-github-linked agents.
 */
export async function resolveCliCwd(
  input: HarnessStreamInput,
): Promise<string | undefined> {
  const vmMetadata = input.virtualMcp.metadata as {
    githubRepo?: unknown;
  } | null;
  if (!vmMetadata?.githubRepo) return undefined;
  if (!input.user?.id) return undefined;

  if (!input.processLocal) {
    const appRoot =
      process.env.WORKDIR || process.env.APP_ROOT || process.cwd();
    return `${appRoot.replace(/\/$/, "")}/repo`;
  }

  const resolveCwd = input.processLocal.resolveCwd;
  if (!resolveCwd) return undefined;
  return await resolveCwd();
}
