/**
 * `/choose-editor` — landing target of the storefront "." shortcut.
 *
 * A live deco storefront redirects here with `?site=&domain=&pageId=&path=&
 * pathTemplate=` (path/pathTemplate arrive URL-encoded once; TanStack decodes
 * them for us — do NOT decode again). `/api/_editor-resolve` returns every
 * (org, project) in the caller's own orgs where `site` is imported, then:
 *   - exactly one → redirect straight into its editor;
 *   - more than one → let the user pick which org/project;
 *   - none / error → a friendly dead-end.
 *
 * The page is auth-gated by `RequiredAuthLayout`, so an unauthenticated visitor
 * is sent to `/login?next=/choose-editor?…` and bounced back with params intact.
 */

import { useState } from "react";
import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loading01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { AgentAvatar } from "@/components/agent-icon";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface EditorMatch {
  orgSlug: string;
  orgName: string;
  project: { id: string; title: string; icon: string | null };
}

interface EditorResolveResult {
  matches: EditorMatch[];
}

interface ResolveError extends Error {
  status?: number;
}

async function resolveEditor(site: string): Promise<EditorResolveResult> {
  const params = new URLSearchParams({ site });
  const res = await fetch(`/api/_editor-resolve?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(`editor-resolve HTTP ${res.status}`) as ResolveError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as EditorResolveResult;
}

/** 4xx means "nothing to open here" (bad slug / not linked / no access). */
function isDeadEnd(error: unknown): boolean {
  const status = (error as ResolveError | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/** The page/preview deep-link the storefront handed us, minus empty values. */
function buildPageSearch(search: ChooseEditorSearch) {
  return {
    ...(search.pageId ? { contentPageId: search.pageId } : {}),
    ...(search.path ? { contentPath: search.path } : {}),
    ...(search.pathTemplate
      ? { contentPathTemplate: search.pathTemplate }
      : {}),
  };
}

interface ChooseEditorSearch {
  site?: string;
  domain?: string;
  pageId?: string;
  path?: string;
  pathTemplate?: string;
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        {children}
      </div>
    </div>
  );
}

function ResolvingScreen() {
  const t = useT();
  return (
    <CenteredCard>
      <Loading01 size={24} className="animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {t("chooseEditor.resolving")}
      </p>
    </CenteredCard>
  );
}

function DeadEndScreen({
  titleKey,
  descriptionKey,
  onRetry,
}: {
  titleKey: "chooseEditor.notFound.title" | "chooseEditor.error.title";
  descriptionKey:
    | "chooseEditor.notFound.description"
    | "chooseEditor.error.description";
  onRetry?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <CenteredCard>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-medium text-foreground">{t(titleKey)}</h1>
        <p className="text-sm text-muted-foreground">{t(descriptionKey)}</p>
      </div>
      <div className="flex items-center gap-2">
        {onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            {t("chooseEditor.retry")}
          </Button>
        ) : null}
        <Button onClick={() => navigate({ to: "/" })}>
          {t("chooseEditor.backToStudio")}
        </Button>
      </div>
    </CenteredCard>
  );
}

/** Declarative one-shot redirect into a project's content editor. */
function EditorRedirect({
  orgSlug,
  projectId,
  pageSearch,
}: {
  orgSlug: string;
  projectId: string;
  pageSearch: Record<string, string>;
}) {
  // Stable across re-renders so the redirect target doesn't churn.
  const [taskId] = useState(() => crypto.randomUUID());
  return (
    <Navigate
      to="/$org/$taskId"
      params={{ org: orgSlug, taskId }}
      search={{ virtualmcpid: projectId, main: "content", ...pageSearch }}
      replace
    />
  );
}

function EditorChooser({
  matches,
  pageSearch,
}: {
  matches: EditorMatch[];
  pageSearch: Record<string, string>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const open = (match: EditorMatch) => {
    navigate({
      to: "/$org/$taskId",
      params: { org: match.orgSlug, taskId: crypto.randomUUID() },
      search: {
        virtualmcpid: match.project.id,
        main: "content",
        ...pageSearch,
      },
    });
  };
  return (
    <CenteredCard>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-medium text-foreground">
          {t("chooseEditor.chooser.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("chooseEditor.chooser.subtitle")}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {matches.map((match) => (
          <button
            key={`${match.orgSlug}/${match.project.id}`}
            type="button"
            onClick={() => open(match)}
            aria-label={t("chooseEditor.chooser.openAriaLabel", {
              title: match.project.title,
              org: match.orgName,
            })}
            className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent"
          >
            <AgentAvatar
              icon={match.project.icon}
              name={match.project.title}
              size="sm"
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {match.project.title}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {match.orgName}
              </span>
            </div>
          </button>
        ))}
      </div>
    </CenteredCard>
  );
}

function ChooseEditor() {
  const search = useSearch({ from: "/choose-editor" }) as ChooseEditorSearch;
  const site = search.site?.trim() ?? "";
  const pageSearch = buildPageSearch(search);

  const query = useQuery({
    queryKey: KEYS.editorResolve(site),
    queryFn: () => resolveEditor(site),
    enabled: site.length > 0,
    staleTime: Infinity,
    retry: (count, error) => !isDeadEnd(error) && count < 2,
  });

  if (!site) {
    return (
      <DeadEndScreen
        titleKey="chooseEditor.notFound.title"
        descriptionKey="chooseEditor.notFound.description"
      />
    );
  }

  if (query.isError) {
    return isDeadEnd(query.error) ? (
      <DeadEndScreen
        titleKey="chooseEditor.notFound.title"
        descriptionKey="chooseEditor.notFound.description"
      />
    ) : (
      <DeadEndScreen
        titleKey="chooseEditor.error.title"
        descriptionKey="chooseEditor.error.description"
        onRetry={() => query.refetch()}
      />
    );
  }

  if (!query.data) {
    return <ResolvingScreen />;
  }

  const { matches } = query.data;
  if (matches.length === 0) {
    return (
      <DeadEndScreen
        titleKey="chooseEditor.notFound.title"
        descriptionKey="chooseEditor.notFound.description"
      />
    );
  }
  if (matches.length === 1 && matches[0]) {
    return (
      <EditorRedirect
        orgSlug={matches[0].orgSlug}
        projectId={matches[0].project.id}
        pageSearch={pageSearch}
      />
    );
  }

  return <EditorChooser matches={matches} pageSearch={pageSearch} />;
}

export default function ChooseEditorRoute() {
  return (
    <RequiredAuthLayout>
      <ChooseEditor />
    </RequiredAuthLayout>
  );
}
