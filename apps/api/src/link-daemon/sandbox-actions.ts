/**
 * TUI → daemon action layer. The link TUI and daemon share one process, so
 * these are plain function calls. `removeSandbox` is the careful path: stop the
 * process, confirm it actually stopped (a run in flight makes the provider
 * refuse), then unmount + rm the branch's files and drop the registry row.
 */
import { join } from "node:path";
import { RetryError, retry } from "@decocms/shared/std";
import type {
  LinkSandboxRegistry,
  SandboxInspection,
} from "../cli/link-sandbox-registry";
import { purgeSandboxFiles } from "./purge-sandbox";
import type { DesktopSandboxProvider } from "./user-desktop-provider";

export interface SandboxActionsDeps {
  provider: Pick<DesktopSandboxProvider, "deleteSandbox" | "hasHandle">;
  registry: Pick<LinkSandboxRegistry, "inspect" | "delete">;
  dataDir: string;
  /** Injectable for tests. Defaults to the real unmount-then-rm. */
  purge?: (sandboxPath: string) => void | Promise<void>;
}

export interface SandboxActions {
  stopSandbox(handle: string): Promise<void>;
  removeSandbox(
    handle: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  inspectSandbox(handle: string): SandboxInspection | null;
}

export function createSandboxActions(deps: SandboxActionsDeps): SandboxActions {
  const purge = deps.purge ?? purgeSandboxFiles;

  return {
    stopSandbox(handle) {
      return deps.provider.deleteSandbox(handle);
    },
    inspectSandbox(handle) {
      return deps.registry.inspect(handle);
    },
    async removeSandbox(handle) {
      try {
        // The first attempt often fails transiently — the process may still be
        // mid-shutdown (provider keeps the handle) or a just-unmounted volume is
        // briefly busy. Retry the whole stop → verify → purge sequence once
        // before bailing so the common case self-heals.
        await retry(
          async () => {
            await deps.provider.deleteSandbox(handle);
            // On refusal (active dispatch) the provider keeps tracking the handle.
            if (deps.provider.hasHandle(handle)) {
              throw new Error("Can't delete — run in progress");
            }
            const rec = deps.registry.inspect(handle);
            const sandboxPath =
              rec?.sandboxPath ?? join(deps.dataDir, "sandboxes", handle);
            await purge(sandboxPath);
          },
          { maxAttempts: 2, minTimeout: 250, jitter: 0 },
        );
        deps.registry.delete(handle);
        return { ok: true };
      } catch (err) {
        const cause = err instanceof RetryError ? err.cause : err;
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  };
}
