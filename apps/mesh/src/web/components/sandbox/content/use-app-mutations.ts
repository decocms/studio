import { sleep } from "@decocms/std";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { publishGitChanges } from "@/web/components/thread/github/sandbox-git-api";
import { decoBlockFilePath } from "@/web/components/sections-editor/deco-block-key";
import {
  resolveSchema,
  type LiveMeta,
} from "@/web/components/sections-editor/resolve-schema";
import { KEYS } from "@/web/lib/query-keys";
import {
  buildInstallBlockData,
  buildInstallWrites,
  buildUninstallPaths,
  catalogEntryLocator,
  appInstallCommitMessage,
  resolveInstallBlockKey,
  type AppLocator,
} from "./app-install";
import type { AppCatalogEntry } from "./app-catalog";

interface SandboxFsParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

function sandboxCacheKey(params: SandboxFsParams): string {
  return `${params.orgSlug}/${params.virtualMcpId}/${params.branch}`;
}

function sandboxBase(params: SandboxFsParams): string {
  return `/api/${params.orgSlug}/sandbox/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}`;
}

async function sandboxWrite(
  params: SandboxFsParams,
  path: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${sandboxBase(params)}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Write failed (${res.status})`,
    );
  }
}

async function sandboxUnlink(
  params: SandboxFsParams,
  path: string,
): Promise<void> {
  const res = await fetch(`${sandboxBase(params)}/unlink`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Delete failed (${res.status})`,
    );
  }
}

async function readBlockData(
  params: SandboxFsParams,
  blockKey: string,
): Promise<Record<string, unknown> | null> {
  const path = decoBlockFilePath(blockKey);
  const res = await fetch(`${sandboxBase(params)}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, full: true }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { kind?: string; content?: string };
  if (data.kind !== "text" || typeof data.content !== "string") return null;
  const raw = data.content.replace(/^\d+\t/gm, "");
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasAppSchemaInMeta(resolveType: string, meta: LiveMeta): boolean {
  return resolveSchema(resolveType, meta) !== null;
}

/** Mirrors admin's post-install wait for dev-server rebuild + meta refresh. */
async function refreshSandboxContentAfterAppChange(
  queryClient: ReturnType<typeof useQueryClient>,
  params: SandboxFsParams,
  resolveType?: string,
): Promise<void> {
  const cacheKey = sandboxCacheKey(params);
  const decofileKey = KEYS.decofile(cacheKey);
  const liveMetaKey = KEYS.liveMeta(cacheKey);

  await queryClient.invalidateQueries({ queryKey: decofileKey });
  await queryClient.refetchQueries({ queryKey: decofileKey });

  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await queryClient.invalidateQueries({ queryKey: liveMetaKey });
    await queryClient.refetchQueries({ queryKey: liveMetaKey });

    if (!resolveType) break;

    const meta = queryClient.getQueryData<LiveMeta>(liveMetaKey);
    if (meta && hasAppSchemaInMeta(resolveType, meta)) break;

    if (attempt < maxAttempts - 1) {
      await sleep(1000);
    }
  }
}

/** Commit + push app install/uninstall files so they survive sandbox stop/start. */
async function persistAppChangeToGit(
  params: SandboxFsParams,
  locator: AppLocator,
  action: "install" | "uninstall",
): Promise<void> {
  try {
    await publishGitChanges(
      params.orgSlug,
      params.virtualMcpId,
      params.branch,
      appInstallCommitMessage(action, locator),
    );
  } catch (err) {
    toast.warning(
      err instanceof Error
        ? `${action === "install" ? "App installed" : "App uninstalled"} locally, but git push failed: ${err.message}. Push your branch before stopping the sandbox or the change will be lost.`
        : `${action === "install" ? "App installed" : "App uninstalled"} locally, but git push failed. Push your branch before stopping the sandbox or the change will be lost.`,
    );
  }
}

export function useInstallApp(params: SandboxFsParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (locator: AppLocator) => {
      for (const write of buildInstallWrites(locator)) {
        await sandboxWrite(params, write.path, write.content);
      }
      const blockKey = resolveInstallBlockKey(locator);
      const blockData = buildInstallBlockData(locator);
      return { blockKey, resolveType: String(blockData.__resolveType) };
    },
    onMutate: async (locator) => {
      const blockKey = resolveInstallBlockKey(locator);
      const blockData = buildInstallBlockData(locator);
      const queryKey = KEYS.decofile(sandboxCacheKey(params));
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => ({
          ...(current ?? {}),
          [blockKey]: blockData,
        }),
      );
      return { previous, queryKey, blockKey };
    },
    onSuccess: async ({ resolveType }, locator) => {
      await refreshSandboxContentAfterAppChange(
        queryClient,
        params,
        resolveType,
      );
      await persistAppChangeToGit(params, locator, "install");
      toast.success("App installed");
    },
    onError: (err, _locator, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Install failed");
    },
  });
}

export function useUninstallApp(params: SandboxFsParams) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      locator,
      blockKey,
    }: {
      locator: AppLocator;
      blockKey: string;
    }) => {
      const blockData = await readBlockData(params, blockKey);
      const paths = buildUninstallPaths(locator, blockKey, blockData);
      for (const path of paths) {
        await sandboxUnlink(params, path);
      }
    },
    onMutate: async ({ blockKey }) => {
      const queryKey = KEYS.decofile(sandboxCacheKey(params));
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<Record<string, unknown>>(queryKey);
      queryClient.setQueryData(
        queryKey,
        (current: Record<string, unknown> | undefined) => {
          if (!current) return current;
          const next = { ...current };
          delete next[blockKey];
          return next;
        },
      );
      return { previous, queryKey };
    },
    onSuccess: async (_result, { locator }) => {
      await refreshSandboxContentAfterAppChange(queryClient, params);
      await persistAppChangeToGit(params, locator, "uninstall");
      toast.success("App uninstalled");
    },
    onError: (err, _variables, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      toast.error(err instanceof Error ? err.message : "Uninstall failed");
    },
  });
}

export function useAppCatalogMutations(
  params: SandboxFsParams,
  opts?: {
    onInstalled?: (entry: AppCatalogEntry, blockKey: string) => void;
    onUninstalled?: (entry: AppCatalogEntry) => void;
  },
) {
  const installApp = useInstallApp(params);
  const uninstallApp = useUninstallApp(params);

  const installEntry = (entry: AppCatalogEntry) => {
    const locator = catalogEntryLocator(entry);
    installApp.mutate(locator, {
      onSuccess: ({ blockKey }) => opts?.onInstalled?.(entry, blockKey),
    });
  };

  const uninstallEntry = (entry: AppCatalogEntry) => {
    if (!entry.blockKey) return;
    uninstallApp.mutate(
      { locator: catalogEntryLocator(entry), blockKey: entry.blockKey },
      { onSuccess: () => opts?.onUninstalled?.(entry) },
    );
  };

  return {
    installEntry,
    uninstallEntry,
    isInstalling: installApp.isPending,
    isUninstalling: uninstallApp.isPending,
    pendingEntryId: installApp.isPending
      ? installApp.variables
        ? appCatalogEntryId(installApp.variables)
        : null
      : uninstallApp.isPending && uninstallApp.variables
        ? appCatalogEntryId(uninstallApp.variables.locator)
        : null,
  };
}

function appCatalogEntryId(locator: AppLocator): string {
  return `${locator.vendor}-${locator.app}`;
}
