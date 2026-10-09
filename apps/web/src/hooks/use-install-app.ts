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
  installDecofileApp,
  setDecofileDraft,
  throwResponseError,
} from "@/components/sections-editor/decofile-api";
import { decofileCacheKey } from "@/components/sections-editor/use-decofile";
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
 * Re-run the package manager and restart the dev script, so the dependency
 * just added to `package.json` is actually in `node_modules`. Pod-addressed —
 * `setup/:step` acts on whatever is running at this ref and takes no thread.
 */
async function reinstallDependencies(ref: SandboxRef): Promise<void> {
  const podRef = { ...ref, threadId: null };
  for (const step of ["install", "start"] as const) {
    const res = await fetch(buildSandboxUrl(podRef, `setup/${step}`), {
      method: "POST",
    });
    if (!res.ok) await throwResponseError(res, `Dependency ${step}`);
  }
}

/**
 * Install a site app from the registry: its decofile block plus the source
 * that resolves it.
 *
 * Two backends, the same split every CMS write has (see `useSaveBlock`). Fast
 * Preview posts the app's id and the server lands every file as one commit; a
 * sandbox session writes them through the daemon, because the pod's working
 * tree — not the branch head — is what the dev server renders.
 *
 * The stack is re-derived from the repository's own manifests in both paths:
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
  const cacheKey = decofileCacheKey({
    orgSlug,
    virtualMcpId,
    branch,
    localPreviewUrl,
  });

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
        const { draft, block } = await installDecofileApp(
          { orgSlug, virtualMcpId, branch },
          blockKey,
        );
        setDecofileDraft(queryClient, { orgSlug, virtualMcpId, branch }, draft);
        // Refresh the branch meta before releasing observers, as useSaveBlock does.
        await queryClient.invalidateQueries({
          queryKey: sandboxGitStatusQueryKey({
            orgSlug,
            virtualMcpId,
            branch,
            threadId,
          }),
        });
        return block;
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

      // Block last: never leave a resolveType with no module behind it.
      for (const file of patches.files) {
        await writeFile(ref, packagePath, file);
      }
      await writeFile(ref, packagePath, {
        path: decoBlockFilePath(patches.block.key),
        content: `${JSON.stringify(patches.block.value, null, 2)}\n`,
      });

      // Only TanStack gains a dependency; Deno has the `apps/` import-map alias.
      if (patches.files.some((file) => file.path === "package.json")) {
        await reinstallDependencies(ref);
      }
      return patches.block;
    },
    onSuccess: (block) => {
      queryClient.setQueryData(
        KEYS.decofile(cacheKey),
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [block.key]: block.value,
        }),
      );
    },
  });
}
