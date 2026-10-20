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

/**
 * A source file's text, or null when it is genuinely not in the checkout.
 * A daemon that is not up yet reads as `unavailable`, which is a different
 * answer — reporting it as absent would make a booting TanStack site look
 * like a repository with no manifests at all.
 */
async function readSource(
  ref: SandboxRef,
  packagePath: string | null,
  relativePath: string,
): Promise<string | null> {
  const read = await readCommittedText(
    ref,
    decoRepoPath(packagePath, relativePath),
  );
  if (read.kind === "unavailable") {
    throw new SiteAppInstallError(
      `Could not read ${relativePath} — the sandbox is still starting up`,
    );
  }
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
 * Run the package manager (`install`) or restart the dev script (`start`).
 * Pod-addressed — `setup/:step` acts on whatever is running at this ref and
 * takes no thread.
 */
async function runSetupStep(
  ref: SandboxRef,
  step: "install" | "start",
): Promise<void> {
  const res = await fetch(
    buildSandboxUrl({ ...ref, threadId: null }, `setup/${step}`),
    { method: "POST" },
  );
  if (!res.ok) await throwResponseError(res, `Dependency ${step}`);
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
      });

      // Shares the editor's pending state: an install writes for seconds, and
      // the header and the preview show that the same way a save does.
      return runContentChange(content, {
        kind: "edit",
        write: async () => {
          const manifest = patches.files.filter(
            (file) => file.path === "package.json",
          );
          const code = patches.files.filter(
            (file) => file.path !== "package.json",
          );
          // The module and the registry entry import the package, so it has to
          // be in node_modules before they exist. In this order a failure
          // leaves at most an unused dependency, never a site that won't build.
          for (const file of manifest) await writeFile(ref, packagePath, file);
          // Deno needs none of this: the `apps/` import-map alias covers it.
          if (patches.dependency) await runSetupStep(ref, "install");
          for (const file of code) await writeFile(ref, packagePath, file);
          // Block last: never leave a resolveType with no module behind it.
          await writeFile(ref, packagePath, {
            path: decoBlockFilePath(patches.block.key),
            content: `${JSON.stringify(patches.block.value, null, 2)}\n`,
          });
          if (patches.dependency) await runSetupStep(ref, "start");
          // The working tree moved by more than one block: the header's change
          // count reads git status, as it does after every other write.
          await queryClient.invalidateQueries({
            queryKey: sandboxGitStatusQueryKey(ref),
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
