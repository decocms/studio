/**
 * `/choose-editor` — landing target of the storefront "." shortcut.
 *
 * A live deco storefront redirects here with `?site=&domain=&pageId=&path=&
 * pathTemplate=` (path/pathTemplate arrive URL-encoded once; TanStack decodes
 * them for us — do NOT decode again). We resolve `(site, domain)` to the
 * project(s) whose content editor should open via `/api/_editor-resolve`, then:
 *   - exactly one project → redirect straight into its editor;
 *   - more than one → let the user pick;
 *   - none / no access / error → a friendly dead-end.
 *
 * The page is auth-gated by `RequiredAuthLayout`, so an unauthenticated visitor
 * is sent to `/login?next=/choose-editor?…` and bounced back with params intact.
 */

import { useState } from "react";
import { Navigate, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loading01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface EditorProject {
  id: string;
  title: string;
  icon: string | null;
  previewServerUrl: string | null;
}

interface EditorResolveResult {
  orgSlug: string;
  projects: EditorProject[];
}

interface ResolveError extends Error {
  status?: number;
}

async function resolveEditor(
  site: string,
  domain: string,
): Promise<EditorResolveResult> {
  const params = new URLSearchParams({ site });
  if (domain) params.set("domain", domain);
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
  result,
  pageSearch,
}: {
  result: EditorResolveResult;
  pageSearch: Record<string, string>;
}) {
  const t = useT();
  const navigate = useNavigate();
  const openProject = (projectId: string) => {
    navigate({
      to: "/$org/$taskId",
      params: { org: result.orgSlug, taskId: crypto.randomUUID() },
      search: { virtualmcpid: projectId, main: "content", ...pageSearch },
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
        {result.projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => openProject(project.id)}
            aria-label={t("chooseEditor.chooser.openAriaLabel", {
              title: project.title,
            })}
            className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent"
          >
            {project.icon ? (
              <img
                src={project.icon}
                alt=""
                className="size-8 shrink-0 rounded-md object-cover"
              />
            ) : (
              <div className="size-8 shrink-0 rounded-md bg-muted" />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground">
                {project.title}
              </span>
              {project.previewServerUrl ? (
                <span className="truncate text-xs text-muted-foreground">
                  {project.previewServerUrl}
                </span>
              ) : null}
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
  const domain = search.domain?.trim() ?? "";
  const pageSearch = buildPageSearch(search);

  const query = useQuery({
    queryKey: KEYS.editorResolve(site, domain),
    queryFn: () => resolveEditor(site, domain),
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

  const { projects } = query.data;
  if (projects.length === 0) {
    return (
      <DeadEndScreen
        titleKey="chooseEditor.notFound.title"
        descriptionKey="chooseEditor.notFound.description"
      />
    );
  }
  if (projects.length === 1 && projects[0]) {
    return (
      <EditorRedirect
        orgSlug={query.data.orgSlug}
        projectId={projects[0].id}
        pageSearch={pageSearch}
      />
    );
  }

  return <EditorChooser result={query.data} pageSearch={pageSearch} />;
}

export default function ChooseEditorRoute() {
  return (
    <RequiredAuthLayout>
      <ChooseEditor />
    </RequiredAuthLayout>
  );
}
