/**
 * First-class git accounts and repositories (`GIT_*` / `REPOSITORY_*` tools).
 *
 * Managed from Settings → Repositories: an org connects provider accounts
 * (GitHub App / OAuth / GitLab token) and links repositories against them.
 * A repository linked without an account is an anonymous public clone, which
 * is also what a repository falls back to when its account is deleted.
 */

import type { GitProviderKind } from "@decocms/shared/git-providers";
import {
  useInfiniteQuery,
  type InfiniteData,
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
  StudioToolIO["REPOSITORY_LINK"]["output"]["repository"];

type RepositorySearchPage = StudioToolIO["REPOSITORY_SEARCH"]["output"];

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
 * is picked; Pages are fetched on demand, with an independent cache per account and query.
 */
export function useSearchProviderRepositories(
  accountId: string | null,
  query: string,
) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useInfiniteQuery<
    RepositorySearchPage,
    Error,
    InfiniteData<RepositorySearchPage>,
    ReturnType<typeof KEYS.providerRepoSearch>,
    number
  >({
    queryKey: KEYS.providerRepoSearch(org.id, accountId ?? "", query),
    enabled: accountId !== null,
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.length + 1 : undefined,
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ pageParam }): Promise<RepositorySearchPage> => {
      if (accountId === null) return { repositories: [], hasMore: false };
      const res = await studio.call("REPOSITORY_SEARCH", {
        accountId,
        page: pageParam,
        perPage: 100,
        ...(query ? { query } : {}),
      });
      return res;
    },
  });
}

export function useConnectGitAccountToken() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      type: GitProviderKind;
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
