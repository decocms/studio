import { useEffect } from "react";
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
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import { KEYS } from "@/web/lib/query-keys";
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

async function listAccessibleRepos(
  selfCallTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>,
  companionCallTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>,
  connectionId: string,
): Promise<string[]> {
  const { installations } = await fetchGithubInstallations(
    selfCallTool,
    connectionId,
  );
  const perAccount = await Promise.all(
    installations.map(async (inst) => {
      const qualifier = inst.type === "User" ? "user" : "org";
      const result = await companionCallTool({
        name: "search_repositories",
        arguments: {
          query: `${qualifier}:${inst.login}`,
          page: 1,
          perPage: 50,
        },
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

  const dataQuery = useQuery({
    queryKey: KEYS.commerceDiscoveryCompanionGithubRepos(org.id, connectionId),
    queryFn: async () => {
      const [repos, cdGet] = await Promise.all([
        listAccessibleRepos(
          (req) => selfClient.callTool(req),
          (req) => companionClient.callTool(req),
          connectionId,
        ),
        selfClient.callTool({
          name: "COLLECTION_CONNECTIONS_GET",
          arguments: { id: cdConnectionId },
        }),
      ]);
      const state =
        unwrapToolResult<{
          item: {
            configuration_state?: Record<string, unknown> | null;
          } | null;
        }>(cdGet).item?.configuration_state ?? null;
      const selectedRepo =
        typeof state?.github_repo === "string" ? state.github_repo : "";
      return { repos, selectedRepo };
    },
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

  if (dataQuery.isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <LoadingIndicator label="Carregando repositórios..." />
      </div>
    );
  }

  if (dataQuery.isError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">
          Não foi possível carregar os repositórios do GitHub.
        </p>
      </div>
    );
  }

  const repos = dataQuery.data?.repos ?? [];
  const selectedRepo = dataQuery.data?.selectedRepo ?? "";

  if (repos.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Nenhum repositório acessível foi encontrado nesta conexão do GitHub.
        </p>
      </div>
    );
  }

  if (selectedRepo && form.getValues("githubRepo") !== selectedRepo) {
    form.setValue("githubRepo", selectedRepo);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Form {...form}>
        <FormField
          control={form.control}
          name="githubRepo"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <SelectableList
                  options={repos.map((fullName) => ({
                    value: fullName,
                    label: fullName,
                  }))}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isPending}
                  ariaLabel="Repositório"
                  searchPlaceholder="Buscar repositório..."
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </Form>

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
