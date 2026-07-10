import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
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
import { KEYS } from "@/web/lib/query-keys";
import { useDebouncedValue } from "@/web/hooks/use-debounced-value.ts";
import { fetchGithubInstallations } from "@/web/lib/github-installations";
import { unwrapToolResult } from "../companions-core.ts";
import { SelectableList } from "./selectable-list.tsx";
import { LoadingIndicator } from "../loading-indicator.tsx";
import type { CompanionFormProps } from "./types.ts";

const schema = z.object({
  githubRepo: z.string().min(1, "Selecione um repositório"),
});

type FormData = z.infer<typeof schema>;

interface GithubSearchRepo {
  full_name: string;
  updated_at?: string;
}

/** A plausible "owner/name" so we can offer any repo as a manual fallback even
 *  when the search index doesn't surface it. */
const OWNER_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Search repos across the user's GitHub App installations. The GitHub search
 * API returns at most `perPage` per call and orders by "best match", so a fixed
 * page-1 listing silently drops most repos of a large org (e.g. deco-sites has
 * 600+). Passing the typed query as an `in:name` filter is what makes an
 * arbitrary repo findable — this is the fix for repos that never appeared.
 */
async function searchRepos(
  selfCallTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>,
  companionCallTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>,
  connectionId: string,
  query: string,
): Promise<string[]> {
  const { installations } = await fetchGithubInstallations(
    selfCallTool,
    connectionId,
  );
  const term = query.trim();
  const perAccount = await Promise.all(
    installations.map(async (inst) => {
      const qualifier = inst.type === "User" ? "user" : "org";
      const q = term
        ? `${qualifier}:${inst.login} ${term} in:name`
        : `${qualifier}:${inst.login}`;
      const result = await companionCallTool({
        name: "search_repositories",
        arguments: { query: q, page: 1, perPage: 50 },
      });
      const content = (result as { content?: Array<{ text?: string }> })
        .content?.[0]?.text;
      if (!content) return [] as GithubSearchRepo[];
      try {
        const parsed = JSON.parse(content) as { items?: GithubSearchRepo[] };
        return parsed.items ?? [];
      } catch {
        return [] as GithubSearchRepo[];
      }
    }),
  );
  const byName = new Map<string, GithubSearchRepo>();
  for (const repo of perAccount.flat()) {
    if (repo.full_name && !byName.has(repo.full_name)) {
      byName.set(repo.full_name, repo);
    }
  }
  return Array.from(byName.values())
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .map((repo) => repo.full_name);
}

export function GitHubConfigForm({
  connectionId,
  companionClient,
  selfClient,
  org,
  onDone,
  onIsPendingChange,
}: CompanionFormProps) {
  const queryClient = useQueryClient();
  // The repo is stored on the Commerce Discovery connection's state
  // (github_repo, owner/name) — the field the repo-audit skill reads at run
  // time — not on the GitHub companion connection like GA4/GSC config values.
  const cdConnectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);

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
        (req) => companionClient.callTool(req),
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
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryConnection(org.id, cdConnectionId),
      });
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnectionsPrefix(org.id),
      });
      onDone();
    },
  });

  const isPending = saveMutation.isPending;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- notify parent of save pending state
  useEffect(() => {
    onIsPendingChange?.(isPending);
  }, [isPending, onIsPendingChange]);

  const handleSubmit = form.handleSubmit(async (data) => {
    saveMutation.mutate(data.githubRepo);
  });

  const selectedRepo = selectedQuery.data ?? "";
  if (selectedRepo && form.getValues("githubRepo") !== selectedRepo) {
    form.setValue("githubRepo", selectedRepo);
  }

  const results = reposQuery.data ?? [];
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
          placeholder="Buscar repositório (ex: deco-sites/fila-store)"
          aria-label="Buscar repositório"
          className="h-8 pl-8"
        />
      </div>

      {reposQuery.isLoading ? (
        <div className="flex min-h-[160px] items-center justify-center">
          <LoadingIndicator label="Carregando repositórios..." />
        </div>
      ) : reposQuery.isError ? (
        <p className="text-sm text-destructive">
          Não foi possível carregar os repositórios do GitHub.
        </p>
      ) : options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhum repositório encontrado. Digite o nome do repositório
          (owner/nome) para buscar.
        </p>
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

      {saveMutation.error && (
        <p role="alert" className="text-sm text-destructive">
          {saveMutation.error instanceof Error
            ? saveMutation.error.message
            : "Não foi possível salvar a configuração"}
        </p>
      )}

      <DialogFooter className="pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={isPending}
        >
          Cancelar
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Salvando..." : "Salvar"}
        </Button>
      </DialogFooter>
    </form>
  );
}
