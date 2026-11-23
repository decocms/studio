/**
 * First-class git accounts and repositories (`GIT_*` / `REPOSITORY_*` tools).
 *
 * Managed from Settings → Repositories: an org connects provider accounts
 * (GitHub App / OAuth / GitLab token) and links repositories against them.
 * A repository linked without an account is an anonymous public clone, which
 * is also what a repository falls back to when its account is deleted.
 */

import type { GitProviderKind } from "@decocms/shared/git-providers";
import { z } from "zod";
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

export type CollaboratorPermission = NonNullable<
  StudioToolIO["REPOSITORY_COLLABORATORS_LIST"]["output"]["collaborators"][number]["permission"]
>;

export type GrantablePermission = NonNullable<
  StudioToolIO["REPOSITORY_COLLABORATOR_ADD"]["input"]["permission"]
>;

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

/** People with direct access to a linked repository, and pending invitations. */
/** Whether Studio manages who has access to the repository, or its owner does on GitHub. */
export function useRepositoryAccessMode(
  repositoryId: string,
  { enabled }: { enabled: boolean },
) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.repositoryAccessMode(org.id, repositoryId),
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => studio.call("REPOSITORY_ACCESS_MODE", { repositoryId }),
  });
}

export function useRepositoryCollaborators(repositoryId: string) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.repositoryCollaborators(org.id, repositoryId),
    retry: false,
    queryFn: () =>
      studio.call("REPOSITORY_COLLABORATORS_LIST", { repositoryId }),
  });
}

function useInvalidateCollaborators(repositoryId: string) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.repositoryCollaborators(org.id, repositoryId),
    });
}

export function useAddCollaborator(repositoryId: string) {
  const studio = useStudioTools();
  const invalidate = useInvalidateCollaborators(repositoryId);
  return useMutation({
    mutationFn: (input: {
      username: string;
      permission: GrantablePermission;
    }) =>
      studio.call("REPOSITORY_COLLABORATOR_ADD", { repositoryId, ...input }),
    onSettled: invalidate,
  });
}

export function useRemoveCollaborator(repositoryId: string) {
  const studio = useStudioTools();
  const invalidate = useInvalidateCollaborators(repositoryId);
  return useMutation({
    mutationFn: (username: string) =>
      studio.call("REPOSITORY_COLLABORATOR_REMOVE", { repositoryId, username }),
    onSettled: invalidate,
  });
}

/** Recent pushes to the repositories monitored for deploys. */
export function useRepositoryDeploys(repositoryIds: readonly string[]) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.repositoryDeploys(org.id, repositoryIds),
    enabled: repositoryIds.length > 0,
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("REPOSITORY_DEPLOYS_LIST", {})).deploys,
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
      /** Required for Bitbucket: an access token cannot name its own workspace. */
      workspace?: string;
    }) => (await studio.call("GIT_ACCOUNT_CONNECT_TOKEN", input)).account,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.gitAccounts(org.id) }),
  });
}

export function useConnectGithubCli() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/${encodeURIComponent(org.slug)}/git-providers/github/cli/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(body);
        throw new Error(error.success ? error.data.error : response.statusText);
      }
      return z
        .object({ account: z.object({ id: z.string(), login: z.string() }) })
        .parse(body).account;
    },
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

/** The account's grant gains the new repository, so accounts refresh too. */
export function useCreateRepositoryFromTemplate() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: StudioToolIO["REPOSITORY_CREATE_FROM_TEMPLATE"]["input"],
    ) =>
      (await studio.call("REPOSITORY_CREATE_FROM_TEMPLATE", input)).repository,
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: KEYS.repositories(org.id),
      });
      void queryClient.invalidateQueries({
        queryKey: KEYS.gitAccounts(org.id),
      });
    },
  });
}

export function useUpdateRepository() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StudioToolIO["REPOSITORY_UPDATE"]["input"]) =>
      (await studio.call("REPOSITORY_UPDATE", input)).repository,
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
