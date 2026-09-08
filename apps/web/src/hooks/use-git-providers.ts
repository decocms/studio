/**
 * First-class git accounts and repositories (`GIT_*` / `REPOSITORY_*` tools).
 *
 * Managed from Settings → Repositories: an org connects provider accounts
 * (GitHub App / OAuth / GitLab token) and links repositories against them.
 * A repository linked without an account is an anonymous public clone, which
 * is also what a repository falls back to when its account is deleted.
 */

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

export type GitProviderCapabilities =
  StudioToolIO["GIT_PROVIDER_CAPABILITIES"]["output"];

export type GitAccount =
  StudioToolIO["GIT_ACCOUNT_LIST"]["output"]["accounts"][number];

export type Repository =
  StudioToolIO["REPOSITORY_LIST"]["output"]["repositories"][number];

export type ProviderRepository =
  StudioToolIO["REPOSITORY_SEARCH"]["output"]["repositories"][number];

/** Capabilities are deployment config — they only change on a redeploy. */
const CAPABILITIES_STALE_MS = 5 * 60_000;

export function useGitProviderCapabilities() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.gitProviderCapabilities(org.id),
    staleTime: CAPABILITIES_STALE_MS,
    queryFn: () => studio.call("GIT_PROVIDER_CAPABILITIES", {}),
  });
}

export function useGitAccounts() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.gitAccounts(org.id),
    staleTime: 60_000,
    queryFn: async () => (await studio.call("GIT_ACCOUNT_LIST", {})).accounts,
  });
}

export function useRepositories(accountId?: string) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.repositories(org.id, accountId),
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("REPOSITORY_LIST", accountId ? { accountId } : {}))
        .repositories,
  });
}

/**
 * Search an account's repositories on the provider. Disabled until an account
 * is picked; `keepPreviousData` holds the previous page's results on screen
 * while the next query text resolves, so typing doesn't flash an empty list.
 */
export function useSearchProviderRepositories(
  accountId: string | null,
  query: string,
) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.providerRepoSearch(org.id, accountId ?? "", query),
    enabled: accountId !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<ProviderRepository[]> => {
      if (accountId === null) return [];
      const res = await studio.call("REPOSITORY_SEARCH", {
        accountId,
        ...(query ? { query } : {}),
      });
      return res.repositories;
    },
  });
}

export function useConnectGitAccountToken() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      type: "github" | "gitlab";
      host: string;
      token: string;
    }) => (await studio.call("GIT_ACCOUNT_CONNECT_TOKEN", input)).account,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.gitAccounts(org.id) }),
  });
}

/** Deleting an account leaves its repositories linked as anonymous clones, so
 *  the repository list is invalidated alongside the account list. */
export function useDeleteGitAccount() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studio.call("GIT_ACCOUNT_DELETE", { id }),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: KEYS.gitAccounts(org.id),
      });
      void queryClient.invalidateQueries({
        queryKey: KEYS.repositories(org.id),
      });
    },
  });
}

export function useLinkRepository() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { url: string; accountId?: string }) =>
      (await studio.call("REPOSITORY_LINK", input)).repository,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.repositories(org.id) }),
  });
}

export function useDeleteRepository() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => studio.call("REPOSITORY_DELETE", { id }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.repositories(org.id) }),
  });
}
