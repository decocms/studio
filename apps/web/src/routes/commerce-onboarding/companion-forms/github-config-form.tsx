import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ConnectionEntity,
  getCommerceDiscoveryAgentId,
  type GithubRepo,
  WellKnownOrgMCPId,
} from "@/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import { SearchSm } from "@untitledui/icons";
import { KEYS, invalidateVirtualMcpQueries } from "@/lib/query-keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import {
  fetchGithubInstallations,
  findGithubInstallation,
} from "@/lib/github-installations";
import { provisionRepoScopedGithubConnection } from "@/lib/provision-repo-scoped-github-connection";
import { isOrgSharedConnection } from "@decocms/shared/github-repo-scope";
import {
  parseRepoFullName,
  planAgentConnections,
  planRepoReuse,
} from "./report-agent-repo-plan";
import { unwrapToolResult } from "../companions-core.ts";
import { SelectableList } from "./selectable-list.tsx";
import { LoadingIndicator } from "../loading-indicator.tsx";
import type { CompanionFormProps } from "./types.ts";
import { useT } from "@/i18n/use-t.ts";

const schema = z.object({
  githubRepo: z
    .string()
    .min(1, "commerceOnboarding.githubConfigForm.selectRepository"),
});

type FormData = z.infer<typeof schema>;

interface GithubSearchRepo {
  full_name: string;
  updated_at?: string;
}

/** Per-account search_repositories timeout — a hung/slow account is treated as a
 *  failure (surfaced to the user) rather than blocking the picker forever. */
const SEARCH_TIMEOUT_MS = 15_000;

/** A plausible "owner/name" so we can offer any repo as a manual fallback even
 *  when the search index doesn't surface it. */
const OWNER_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

interface RepoSearchResult {
  repos: string[];
  /** Installations whose search call failed (error/timeout/unparseable). */
  failed: number;
  /** Total installations searched. */
  total: number;
}

/**
 * Search repos across the user's GitHub App installations. The GitHub search
 * API returns at most `perPage` per call and orders by "best match", so a fixed
 * page-1 listing silently drops most repos of a large org (e.g. deco-sites has
 * 600+). Passing the typed query as an `in:name` filter is what makes an
 * arbitrary repo findable — this is the fix for repos that never appeared.
 *
 * Each account is searched independently (allSettled) and per-call timed out, so
 * one slow/failing account doesn't blank the whole picker. The count of failed
 * accounts is returned so the UI can WARN instead of implying "no repos exist"
 * when the search actually errored or timed out.
 */
async function searchRepos(
  selfCallTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>,
  companionClient: Client,
  connectionId: string,
  query: string,
): Promise<RepoSearchResult> {
  const { installations } = await fetchGithubInstallations(
    selfCallTool,
    connectionId,
  );
  const term = query.trim();
  const settled = await Promise.allSettled(
    installations.map(async (inst) => {
      const qualifier = inst.type === "User" ? "user" : "org";
      const q = term
        ? `${qualifier}:${inst.login} ${term} in:name`
        : `${qualifier}:${inst.login}`;
      const result = await companionClient.callTool(
        {
          name: "search_repositories",
          arguments: { query: q, page: 1, perPage: 50 },
        },
        undefined,
        { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) },
      );
      const typed = result as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      const content = typed.content?.[0]?.text;
      // A tool-level error carries text but is NOT a valid payload — surface it
      // as a failure instead of parsing it into an empty list.
      if (typed.isError) {
        throw new Error(content ?? "search_repositories failed");
      }
      if (!content) throw new Error("empty search_repositories response");
      const parsed = JSON.parse(content) as { items?: GithubSearchRepo[] };
      return parsed.items ?? [];
    }),
  );

  const byName = new Map<string, GithubSearchRepo>();
  let failed = 0;
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      failed += 1;
      continue;
    }
    for (const repo of outcome.value) {
      if (repo.full_name && !byName.has(repo.full_name)) {
        byName.set(repo.full_name, repo);
      }
    }
  }
  const repos = Array.from(byName.values())
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .map((repo) => repo.full_name);
  return { repos, failed, total: installations.length };
}

export function GitHubConfigForm({
  connectionId,
  companionClient,
  selfClient,
  org,
  onDone,
  onIsPendingChange,
}: CompanionFormProps) {
  const t = useT();
  const queryClient = useQueryClient();
  // The repo is stored on the Commerce Discovery connection's state
  // (github_repo, owner/name) — the field the repo-audit skill reads at run
  // time — not on the GitHub companion connection like GA4/GSC config values.
  const cdConnectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  // Applies the persisted repo to the form ONCE, the first time the prefill
  // query resolves. selectedQuery only refetches after a successful save, so
  // without this guard every render caused by the user picking a different
  // repo would see the (still-stale) persisted value and immediately revert
  // their selection back to it before they could hit Save.
  const prefilledRef = useRef(false);

  // Prefill: the repo currently persisted on the CD connection.
  const selectedQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionGithubSelected(
      org.id,
      connectionId,
    ),
    queryFn: async () => {
      const cdGet = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: cdConnectionId },
      });
      const state =
        unwrapToolResult<{
          item: {
            configuration_state?: Record<string, unknown> | null;
          } | null;
        }>(cdGet).item?.configuration_state ?? null;
      return typeof state?.github_repo === "string" ? state.github_repo : "";
    },
  });

  const reposQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionGithubRepos(
      org.id,
      connectionId,
      debouncedSearch.trim(),
    ),
    queryFn: () =>
      searchRepos(
        (req) => selfClient.callTool(req),
        companionClient,
        connectionId,
        debouncedSearch,
      ),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { githubRepo: "" },
  });

  const saveMutation = useMutation({
    mutationFn: async (githubRepo: string) => {
      const cdGet = await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_GET",
        arguments: { id: cdConnectionId },
      });
      const currentState =
        unwrapToolResult<{
          item: {
            configuration_state?: Record<string, unknown> | null;
          } | null;
        }>(cdGet).item?.configuration_state ?? null;
      const merged = { ...(currentState ?? {}), github_repo: githubRepo };
      await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_UPDATE",
        arguments: {
          id: cdConnectionId,
          data: { configuration_state: merged },
        },
      });

      // Mirror onto the Report Agent virtual MCP's `metadata.githubRepo` —
      // `agentHasClonableSource` reads it to show the Preview/Code tabs and
      // SANDBOX_START reads it to clone. A bare `{ owner, name, url }` clones
      // anonymously (fails on a private store repo), so provision a repo-scoped
      // GitHub connection (same path the repo picker uses) and store its
      // `connectionId` so the clone is authenticated.
      const parsed = parseRepoFullName(githubRepo);
      if (!parsed) {
        throw new Error(
          t("commerceOnboarding.githubConfigForm.invalidRepository", {
            repo: githubRepo,
          }),
        );
      }
      const { owner, name } = parsed;
      const agentId = getCommerceDiscoveryAgentId(org.id);

      const agentItem = unwrapToolResult<{
        item: {
          metadata?: { githubRepo?: GithubRepo | null } | null;
          connections?: Array<{ connection_id: string }> | null;
        } | null;
      }>(
        await selfClient.callTool({
          name: "COLLECTION_VIRTUAL_MCP_GET",
          arguments: { id: agentId },
        }),
      ).item;
      const existingRepo = agentItem?.metadata?.githubRepo;
      const existingConnections = agentItem?.connections ?? [];

      // Reuse the existing repo-scoped connection when the same repo is
      // re-saved so a no-op save doesn't orphan a fresh connection each time.
      const reuse = planRepoReuse({ existingRepo, owner, name });

      let repoConnectionId = reuse?.connectionId;
      let installationId = reuse?.installationId;
      // The connection we mint below, if any — deleted on a later failure so a
      // partial save leaves nothing behind (the picker flow does the same).
      let provisionedConnectionId: string | undefined;

      if (!repoConnectionId) {
        const { installations } = await fetchGithubInstallations(
          (req) => selfClient.callTool(req),
          connectionId,
        );
        const installation = findGithubInstallation(installations, owner);
        if (!installation) {
          throw new Error(
            t("commerceOnboarding.githubConfigForm.noGithubInstallation", {
              owner,
            }),
          );
        }
        installationId = installation.installationId;
        const sourceConnection = unwrapToolResult<{
          item: ConnectionEntity | null;
        }>(
          await selfClient.callTool({
            name: "COLLECTION_CONNECTIONS_GET",
            arguments: { id: connectionId },
          }),
        ).item;
        if (!sourceConnection) {
          throw new Error(
            t("commerceOnboarding.githubConfigForm.githubConnectionNotFound"),
          );
        }
        const { childConnectionId, reused } =
          await provisionRepoScopedGithubConnection({
            orgSlug: org.slug,
            sourceConnection,
            installationId,
            owner,
            repo: name,
            githubCallTool: (req) => companionClient.callTool(req),
            selfCallTool: (req) => selfClient.callTool(req),
          });
        repoConnectionId = childConnectionId;
        // Only roll back a connection this save created; a reused one predates
        // it and other agents may hold it.
        provisionedConnectionId = reused ? undefined : childConnectionId;
      }

      // Aggregate the repo-scoped connection onto the agent — `git publish`
      // (parseGithubRepoFromMetadata) only trusts `githubRepo.connectionId` when
      // it's one of the agent's connections. A previous save may have linked a
      // different repo whose connection now leaks (metadata overwrite does no
      // cascade); planAgentConnections drops it from the list so the
      // de-aggregation lands before its delete below (child_connection_id is
      // ON DELETE RESTRICT, migration 026).
      const { staleConnectionId, mergedConnections } = planAgentConnections({
        existingRepo,
        existingConnections,
        repoConnectionId,
      });

      try {
        await selfClient.callTool({
          name: "COLLECTION_VIRTUAL_MCP_UPDATE",
          arguments: {
            id: agentId,
            data: {
              connections: mergedConnections,
              metadata: {
                githubRepo: {
                  owner,
                  name,
                  url: `https://github.com/${githubRepo}`,
                  installationId,
                  connectionId: repoConnectionId,
                },
              },
            },
          },
        });
        // The previously-linked repo connection is only ours to delete when
        // it's ours alone. An org-shared one ("Add repo") belongs to the org
        // and has no aggregation row to protect it. A connection another agent
        // aggregates IS protected — child_connection_id is ON DELETE RESTRICT,
        // so the delete throws into the catch below and the row survives.
        if (staleConnectionId) {
          const stale = unwrapToolResult<{ item: ConnectionEntity | null }>(
            await selfClient.callTool({
              name: "COLLECTION_CONNECTIONS_GET",
              arguments: { id: staleConnectionId },
            }),
          ).item;
          if (stale && !isOrgSharedConnection(stale)) {
            await selfClient
              .callTool({
                name: "COLLECTION_CONNECTIONS_DELETE",
                arguments: { id: staleConnectionId, force: true },
              })
              .catch(() => {});
          }
        }
      } catch (err) {
        // The connectionId lives only on the metadata we just failed to write,
        // so the reuse guard can never recover it — delete it now, else every
        // retry mints another orphan.
        if (provisionedConnectionId) {
          await selfClient
            .callTool({
              name: "COLLECTION_CONNECTIONS_DELETE",
              arguments: { id: provisionedConnectionId, force: true },
            })
            .catch(() => {});
        }
        throw err;
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
      });
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnectionsPrefix(org.id),
      });
      invalidateVirtualMcpQueries(queryClient, org.id);
      onDone();
    },
  });

  const isPending = saveMutation.isPending;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- notify parent of save pending state
  useEffect(() => {
    onIsPendingChange?.(isPending);
  }, [isPending, onIsPendingChange]);

  const selectedRepo = selectedQuery.data ?? "";
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- prefill the form once from the persisted repo (an async query result), not on every render
  useEffect(() => {
    if (!selectedQuery.isSuccess || prefilledRef.current) return;
    prefilledRef.current = true;
    if (selectedQuery.data) form.setValue("githubRepo", selectedQuery.data);
  }, [selectedQuery.isSuccess, selectedQuery.data, form]);

  const handleSubmit = form.handleSubmit(async (data) => {
    saveMutation.mutate(data.githubRepo);
  });

  const results = reposQuery.data?.repos ?? [];
  const failedAccounts = reposQuery.data?.failed ?? 0;
  const totalAccounts = reposQuery.data?.total ?? 0;
  const trimmed = debouncedSearch.trim();
  // Guarantee any repo is selectable: if the search yields nothing but the term
  // is a valid owner/name, offer it directly (and always keep the currently
  // selected repo in the list so it renders as chosen).
  const options = [...results];
  if (trimmed && OWNER_NAME_RE.test(trimmed) && !options.includes(trimmed)) {
    options.unshift(trimmed);
  }
  if (selectedRepo && !options.includes(selectedRepo)) {
    options.push(selectedRepo);
  }

  // A partial failure (some accounts errored/timed out) may hide real repos; a
  // total failure means the list is empty because the search broke, not because
  // there are no repos. Warn in both cases instead of showing a silent empty.
  const allAccountsFailed =
    totalAccounts > 0 && failedAccounts === totalAccounts;
  const searchWarning =
    reposQuery.isError || allAccountsFailed
      ? t("commerceOnboarding.githubConfigForm.searchFailedTotal")
      : failedAccounts > 0
        ? t("commerceOnboarding.githubConfigForm.searchFailedPartial")
        : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="relative">
        <SearchSm
          size={16}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={isPending}
          placeholder={t(
            "commerceOnboarding.githubConfigForm.searchRepositoryPlaceholder",
          )}
          aria-label={t(
            "commerceOnboarding.githubConfigForm.searchRepositoryLabel",
          )}
          className="h-8 pl-8"
        />
      </div>

      {reposQuery.isLoading ? (
        <div className="flex min-h-[160px] items-center justify-center">
          <LoadingIndicator
            label={t("commerceOnboarding.githubConfigForm.loadingRepositories")}
          />
        </div>
      ) : (
        <>
          {searchWarning && (
            <p role="alert" className="text-sm text-destructive">
              {searchWarning}
            </p>
          )}
          {options.length === 0 ? (
            !searchWarning && (
              <p className="text-sm text-muted-foreground">
                {t("commerceOnboarding.githubConfigForm.noRepositoriesFound")}
              </p>
            )
          ) : (
            <Form {...form}>
              <FormField
                control={form.control}
                name="githubRepo"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <SelectableList
                        options={options.map((fullName) => ({
                          value: fullName,
                          label: fullName,
                        }))}
                        value={field.value}
                        onChange={field.onChange}
                        disabled={isPending}
                        ariaLabel="Repositório"
                        hideSearch
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </Form>
          )}
        </>
      )}

      {saveMutation.error && (
        <p role="alert" className="text-sm text-destructive">
          {saveMutation.error instanceof Error
            ? saveMutation.error.message
            : t("commerceOnboarding.githubConfigForm.failedToSave")}
        </p>
      )}

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isPending}
        >
          {t("commerceOnboarding.githubConfigForm.cancel")}
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending
            ? t("commerceOnboarding.githubConfigForm.saving")
            : t("commerceOnboarding.githubConfigForm.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
