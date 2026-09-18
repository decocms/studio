/**
 * `/$repoOwner/$repoName/$prNumber` — the `deco.studio/<org>/<repo>/<pr>`
 * shortlink, the cheapest way to hand someone a branch to collaborate on.
 *
 * `/api/_pr-resolve` returns every (org, project) in the caller's own orgs
 * where `<owner>/<repo>` is imported, plus the branch that pull request
 * proposes, then:
 *   - exactly one → open its Site Editor on that branch with the chat open;
 *   - more than one → let the user pick which org/project;
 *   - none / error → a friendly dead-end.
 *
 * Landing on the branch: when the caller already has a chat pinned to it we
 * resume that one. Otherwise we mint a thread id and park a thread intent on
 * it, which is exactly how the in-app create paths hand a branch to
 * `useEnsureTask`'s create-on-404 — see `lib/thread-intent.ts`.
 *
 * The page is auth-gated by `RequiredAuthLayout`, so an unauthenticated visitor
 * is sent to `/login?next=/<owner>/<repo>/<pr>` and bounced back.
 */

import { Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
import { AgentAvatar } from "@/components/agent-icon";
import RequiredAuthLayout from "@/layouts/required-auth-layout";
import { KEYS } from "@/lib/query-keys";
import { writeThreadIntent } from "@/lib/thread-intent";
import { useT } from "@/i18n/use-t.ts";

interface PrMatch {
  orgId: string;
  orgSlug: string;
  orgName: string;
  project: { id: string; title: string; icon: string | null };
  branch: string | null;
  threadId: string | null;
}

interface PrResolveResult {
  matches: PrMatch[];
}

interface ResolveError extends Error {
  status?: number;
}

async function resolvePr(
  owner: string,
  repo: string,
  pr: string,
): Promise<PrResolveResult> {
  const params = new URLSearchParams({ owner, repo, pr });
  const res = await fetch(`/api/_pr-resolve?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(`pr-resolve HTTP ${res.status}`) as ResolveError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as PrResolveResult;
}

/** 4xx means "nothing to open here" (bad ref / not imported / no access). */
function isDeadEnd(error: unknown): boolean {
  const status = (error as ResolveError | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * The thread this link should land in, and the branch to stamp on it when it
 * has to be created. the locator is `<orgId>/<projectId>`, the same one
 * `ShellProjectProvider` builds, so the intent parked here is the one the editor's
 * `useEnsureTask` claims.
 */
function landingThread(match: PrMatch, mintedThreadId: string): string {
  if (match.threadId) return match.threadId;
  if (match.branch) {
    writeThreadIntent(
      sessionStorage,
      `${match.orgId}/${match.project.id}`,
      mintedThreadId,
      { branch: match.branch },
    );
  }
  return mintedThreadId;
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
      <Spinner className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t("openPr.resolving")}</p>
    </CenteredCard>
  );
}

function DeadEndScreen({
  titleKey,
  descriptionKey,
  onRetry,
}: {
  titleKey: "openPr.notFound.title" | "openPr.error.title";
  descriptionKey: "openPr.notFound.description" | "openPr.error.description";
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
            {t("openPr.retry")}
          </Button>
        ) : null}
        <Button onClick={() => navigate({ to: "/" })}>
          {t("openPr.backToStudio")}
        </Button>
      </div>
    </CenteredCard>
  );
}

/** Declarative one-shot redirect into the project's editor on the PR's branch. */
function PrRedirect({
  match,
  mintedThreadId,
}: {
  match: PrMatch;
  mintedThreadId: string;
}) {
  return (
    <Navigate
      to={PROJECT_ROUTE.siteEditor}
      params={{ org: match.orgSlug, agentId: match.project.id }}
      search={{ thread: landingThread(match, mintedThreadId), sidepanel: true }}
      replace
    />
  );
}

function PrChooser({
  matches,
  mintedThreadId,
}: {
  matches: PrMatch[];
  mintedThreadId: string;
}) {
  const t = useT();
  const navigate = useNavigate();
  const open = (match: PrMatch) => {
    navigate({
      to: PROJECT_ROUTE.siteEditor,
      params: { org: match.orgSlug, agentId: match.project.id },
      search: {
        thread: landingThread(match, mintedThreadId),
        sidepanel: true,
      },
    });
  };
  return (
    <CenteredCard>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-medium text-foreground">
          {t("openPr.chooser.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("openPr.chooser.subtitle")}
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {matches.map((match) => (
          <button
            key={`${match.orgSlug}/${match.project.id}`}
            type="button"
            onClick={() => open(match)}
            aria-label={t("openPr.chooser.openAriaLabel", {
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
                {match.branch
                  ? `${match.orgName} · ${match.branch}`
                  : match.orgName}
              </span>
            </div>
          </button>
        ))}
      </div>
    </CenteredCard>
  );
}

function OpenPr() {
  const params = useParams({ from: "/$repoOwner/$repoName/$prNumber" });
  const owner = params.repoOwner;
  const repo = params.repoName;
  const pr = params.prNumber;
  /** Minted once per mount so a re-render before the URL catches up reuses it. */
  const [mintedThreadId] = useState(() => crypto.randomUUID());

  const query = useQuery({
    queryKey: KEYS.prResolve(owner, repo, pr),
    queryFn: () => resolvePr(owner, repo, pr),
    staleTime: Infinity,
    retry: (count, error) => !isDeadEnd(error) && count < 2,
  });

  if (query.isError) {
    return isDeadEnd(query.error) ? (
      <DeadEndScreen
        titleKey="openPr.notFound.title"
        descriptionKey="openPr.notFound.description"
      />
    ) : (
      <DeadEndScreen
        titleKey="openPr.error.title"
        descriptionKey="openPr.error.description"
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
        titleKey="openPr.notFound.title"
        descriptionKey="openPr.notFound.description"
      />
    );
  }
  if (matches.length === 1 && matches[0]) {
    return <PrRedirect match={matches[0]} mintedThreadId={mintedThreadId} />;
  }

  return <PrChooser matches={matches} mintedThreadId={mintedThreadId} />;
}

export default function OpenPrRoute() {
  return (
    <RequiredAuthLayout>
      <OpenPr />
    </RequiredAuthLayout>
  );
}
