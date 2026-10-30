import { useMutation, useQueryClient } from "@tanstack/react-query";
import { decoBlockFilePath } from "@decocms/shared/decofile";
import {
  detectSiteTechnology,
  findSiteApp,
  makeInstallAppPatches,
  SiteAppInstallError,
  type SiteAppFilePatch,
} from "@decocms/shared/site-apps";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { decoRepoPath } from "@/components/sections-editor/deco-repo-path";
import {
  decofileWriteMutationKey,
  decofileWriteScope,
  throwResponseError,
} from "@/components/sections-editor/decofile-api";
import { runContentChange } from "@/components/sections-editor/content-sync";
import { useContentSyncTarget } from "@/components/sections-editor/use-content-sync";
import { usePackagePath } from "@/components/sections-editor/use-package-path";
import { readCommittedText } from "@/components/sections-editor/read-committed-file";
import { sandboxGitStatusQueryKey } from "@/components/thread/repository/sandbox-git-api";
import {
  dependencyInstallFor,
  needsDevRestart,
} from "@/hooks/dependency-install";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { KEYS } from "@/lib/query-keys";
import { buildSandboxUrl } from "@/sdk/sandbox-url";

interface UseInstallAppParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

interface SandboxRef {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
}

/** The numeric `.status` a read fallback tags onto its thrown Error. */
function errorStatus(error: unknown): number | undefined {
  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
}

/** The sandbox is there but not answering yet, as a read reports it. */
function notAnsweringYet(relativePath: string): SiteAppInstallError {
  return new SiteAppInstallError(
    `Could not read ${relativePath} — the sandbox is not answering yet. Try again in a moment.`,
  );
}

/**
 * A source file's text, or null when it is genuinely not in the checkout.
 * A daemon that is not up yet reads as `unavailable`, which is a different
 * answer — reporting it as absent would make a booting TanStack site look
 * like a repository with no manifests at all.
 * A 5xx is that too: a paused VM wakes slower than the proxy waits.
 */
async function readSource(
  ref: SandboxRef,
  packagePath: string | null,
  relativePath: string,
): Promise<string | null> {
  const read = await readCommittedText(
    ref,
    decoRepoPath(packagePath, relativePath),
  ).catch((error: unknown) => {
    const status = errorStatus(error);
    if (status !== undefined && status >= 500)
      throw notAnsweringYet(relativePath);
    throw error;
  });
  if (read.kind === "unavailable") throw notAnsweringYet(relativePath);
  return read.kind === "data" ? read.data : null;
}

async function writeFile(
  ref: SandboxRef,
  packagePath: string | null,
  file: SiteAppFilePatch,
): Promise<void> {
  const res = await fetch(buildSandboxUrl(ref, "write"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: decoRepoPath(packagePath, file.path),
      content: file.content,
    }),
  });
  if (!res.ok) await throwResponseError(res, "Write");
}

/**
 * Ask the pod to install the dependency this install needs.
 *
 * `force` is for the case the daemon cannot see: its install fingerprint is
 * the package manager, the runtime and the branch HEAD, so a `package.json`
 * we just rewrote in the working tree leaves it unchanged and the step would
 * skip. Forced only when we actually rewrote it — forcing otherwise tears
 * down a healthy dev server to reinstall a tree that did not move.
 *
 * Unforced is still worth sending when the dependency is already declared: it
 * no-ops when the fingerprint matches, and it is what recovers an earlier
 * attempt whose install failed (a failure marks the fingerprint bad, so the
 * step runs).
 *
 * Returns once the step is QUEUED, not once it is done — the orchestrator runs
 * it on its own goroutine. A failure surfaces in the setup stream, not here.
 *
 * Pod-addressed: `setup/:step` acts on whatever is running at this ref and
 * takes no thread.
 */
async function requestDependencyInstall(
  ref: SandboxRef,
  force: boolean,
): Promise<void> {
  const res = await fetch(
    buildSandboxUrl({ ...ref, threadId: null }, "setup/install", {
      force: force ? "1" : "0",
    }),
    { method: "POST" },
  );
  if (!res.ok) await throwResponseError(res, "Dependency install");
  await assertForceHonoured(res, force, "install");
}

/**
 * Prove the step we asked to bypass its short-circuit actually will.
 *
 * A daemon that predates the flag reads the step out of the path and ignores
 * the body entirely, then answers 200 — so the install short-circuits on a
 * fingerprint the new `package.json` did not move, and the app's module
 * imports a package that is not in `node_modules`. A pool pod can be running
 * that image for as long as the rollout takes. The handler echoes `force` back
 * precisely so the caller can tell the two apart; reading it is what turns a
 * silent wrong answer into one the user can act on.
 */
async function assertForceHonoured(
  res: Response,
  force: boolean,
  step: string,
): Promise<void> {
  if (!force) return;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const echoed =
    typeof body === "object" && body !== null && "force" in body
      ? body.force
      : undefined;
  if (echoed === true) return;
  throw new SiteAppInstallError(
    `This sandbox is running a daemon that ignores a forced ${step}, so the install would answer "done" without doing it. Restart the sandbox to pick up a current image, then install again.`,
  );
}

/**
 * Ask the pod to restart the dev server.
 *
 * An app's form is generated from the app's own module, so `/live/_meta` has
 * no entry for what we just wrote until the runtime re-reads the manifest —
 * the CMS then has nothing to render, and reloading the page does not help.
 *
 * Forced, because the dev server is healthy and running: that is exactly the
 * case the unforced start skips. Queued, not awaited, like the install above.
 */
async function requestDevRestart(ref: SandboxRef): Promise<void> {
  const res = await fetch(
    buildSandboxUrl({ ...ref, threadId: null }, "setup/start", { force: "1" }),
    { method: "POST" },
  );
  if (!res.ok) await throwResponseError(res, "Dev restart");
  await assertForceHonoured(res, true, "restart");
}

/**
 * Install a site app from the registry: its decofile block plus the source
 * that resolves it.
 *
 * Only in a coding session, and only through the daemon: installing writes
 * code, and the pod's working tree — not the branch head — is what the dev
 * server renders, so a Fast Preview session is refused rather than served by
 * a second backend.
 *
 * The stack is re-derived from the repository's own manifests before writing:
 * the catalogue the user picked from is chosen off `metadata.runtime.selected`,
 * which can be stale, and writing a Deno re-export into a TanStack site would
 * leave a branch that does not build.
 */
export function useInstallApp({
  orgSlug,
  virtualMcpId,
  branch,
}: UseInstallAppParams) {
  const queryClient = useQueryClient();
  const threadId = useOptionalChatTask()?.taskId ?? null;
  const packagePath = usePackagePath(virtualMcpId);
  const fastPreviewActive = useSessionRuntime(virtualMcpId).runtime === "cms";
  /** Local mode renders a pasted tunnel and persists nothing — see `useSaveBlock`. */
  const { url: localPreviewUrl } = useLocalPreviewUrl(virtualMcpId);
  const content = useContentSyncTarget({ orgSlug, virtualMcpId, branch });

  return useMutation({
    mutationKey: decofileWriteMutationKey(orgSlug, virtualMcpId, branch),
    // Serialized against block autosaves: an install writes a block too.
    scope: decofileWriteScope(orgSlug, virtualMcpId, branch),
    mutationFn: async ({ blockKey }: { blockKey: string }) => {
      if (localPreviewUrl) {
        throw new SiteAppInstallError(
          "Local preview has no repository to install into",
        );
      }

      if (fastPreviewActive) {
        throw new SiteAppInstallError(
          "Installing an app writes code, which a Fast Preview session cannot do",
        );
      }

      const ref: SandboxRef = { orgSlug, virtualMcpId, branch, threadId };
      const [denoJson, packageJson] = await Promise.all([
        readSource(ref, packagePath, "deno.json"),
        readSource(ref, packagePath, "package.json"),
      ]);
      const detected = detectSiteTechnology({ denoJson, packageJson });
      if (!detected) {
        throw new SiteAppInstallError(
          "This repository has no deno.json or package.json",
        );
      }
      const entry = findSiteApp(detected.technology, blockKey);
      if (!entry) {
        throw new SiteAppInstallError(
          `No app "${blockKey}" is available for a ${detected.technology} site`,
        );
      }

      const patches = makeInstallAppPatches({
        technology: detected.technology,
        entry,
        decocmsVersion: detected.decocmsVersion,
        packageJson,
        setupTs:
          detected.technology === "tanstack"
            ? await readSource(ref, packagePath, "src/setup.ts")
            : null,
        manifestGenTs:
          detected.technology === "deno"
            ? await readSource(ref, packagePath, "manifest.gen.ts")
            : null,
      });

      // Shares the editor's pending state: an install writes for seconds, and
      // the header and the preview show that the same way a save does.
      return runContentChange(content, {
        kind: "edit",
        write: async () => {
          // Every CODE file first, then the pod is asked to act on the tree.
          // Both setup steps return once the step is QUEUED, and a forced
          // install cascades straight into the start that respawns the dev
          // server — so a request sent between two writes races the very files
          // it exists to pick up, and the dev server can boot on a tree that is
          // still half written.
          for (const file of patches.files) {
            await writeFile(ref, packagePath, file);
          }
          const install = dependencyInstallFor(patches);
          if (install) await requestDependencyInstall(ref, install.force);
          // Only when the step above did not already do it: the restart is
          // what puts the app's schema in `/live/_meta`.
          if (needsDevRestart(patches, install)) await requestDevRestart(ref);
          // The block is LAST, after the pod has accepted the work, because
          // the block is what marks the app installed: the catalogue reads
          // nothing else (`app-catalog`), and an app that reads as installed
          // opens its editor instead of the install panel, so there is no way
          // left to retry. Writing it only once the install is under way keeps
          // a failed one offering Install again — and a retry is idempotent,
          // since every artifact already in place is left out of the patches.
          await writeFile(ref, packagePath, {
            path: decoBlockFilePath(patches.block.key),
            content: `${JSON.stringify(patches.block.value, null, 2)}\n`,
          });
          // The working tree moved by more than one block: the header's change
          // count reads git status, as it does after every other write.
          await queryClient.invalidateQueries({
            queryKey: sandboxGitStatusQueryKey(ref),
          });
          // The held schema predates this app, and its key carries no commit
          // to age it out — the same invalidation a block delete does.
          await queryClient.invalidateQueries({
            queryKey: KEYS.liveMeta(orgSlug, virtualMcpId, branch),
          });
          return patches.block;
        },
      });
    },
    onSuccess: (block) => {
      if (!content.cacheKey) return;
      queryClient.setQueryData(
        KEYS.decofile(content.cacheKey),
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [block.key]: block.value,
        }),
      );
    },
  });
}
