import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { AlertCircle, Box, LinkExternal01 } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty-state";
import type { ContentBackend } from "@/components/sections-editor/content-backend";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";

const BLOCKS_DOCS_URL = "https://github.com/decocms/blocks";

export function BlocksEmptyState() {
  const t = useT();
  return (
    <EmptyState
      className="h-full w-full"
      image={<Box size={48} className="text-muted-foreground" />}
      title={t("mainPanelTabs.blocksTabStates.emptyStateTitle")}
      description={t("mainPanelTabs.blocksTabStates.emptyStateDescription")}
      actions={
        <Button size="sm" asChild>
          <a href={BLOCKS_DOCS_URL} target="_blank" rel="noreferrer">
            {t("mainPanelTabs.blocksTabStates.setupContentEditing")}
            <LinkExternal01 size={14} />
          </a>
        </Button>
      }
    />
  );
}

export function BlocksErrorState({
  source,
  onRetry,
}: {
  source: "sandbox" | "data";
  onRetry: () => void;
}) {
  const t = useT();
  const description =
    source === "sandbox"
      ? t("mainPanelTabs.blocksTabStates.errorStateSandbox")
      : t("mainPanelTabs.blocksTabStates.errorStateData");
  return (
    <EmptyState
      image={<AlertCircle size={48} className="text-muted-foreground" />}
      title={t("mainPanelTabs.blocksTabStates.errorStateTitle")}
      description={description}
      actions={
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("mainPanelTabs.blocksTabStates.retry")}
        </Button>
      }
    />
  );
}

/** A Blocks v8 site another project owns (Studio answered `site_not_owned`). */
export function isSiteNotOwned(backend: ContentBackend): boolean {
  return backend.kind === "unavailable" && backend.siteNotOwned === true;
}

/**
 * The editor of a Blocks v8 site another project owns: says where its content
 * is edited instead of an error or an endless retry.
 */
export function SiteNotOwnedState() {
  const t = useT();
  const { org } = useProjectContext();
  return (
    <EmptyState
      className="h-full w-full"
      image={<Box size={48} className="text-muted-foreground" />}
      title={t("siteEditor.siteNotOwned.title")}
      description={t("siteEditor.siteNotOwned.body")}
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link
            to="/$org/projects"
            params={{ org: org.slug }}
            data-testid="site-not-owned-projects"
          >
            {t("siteEditor.siteNotOwned.openProjects")}
          </Link>
        </Button>
      }
    />
  );
}

/**
 * The editor waiting for the schema that decides v7 or v8 (the content
 * backend is `pending`). When that read failed and is retried, it says so,
 * in neutral words: the site may be either, so neither editor shows.
 */
export function ContentBackendWaiting({
  backend,
}: {
  backend: ContentBackend;
}) {
  const t = useT();
  const retrying = backend.kind === "pending" ? backend.retrying : undefined;
  return (
    <div
      data-testid="content-backend-waiting"
      className="flex h-full w-full flex-col items-center justify-center gap-3"
    >
      <Spinner className="size-5 text-muted-foreground" />
      {retrying && (
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          {t(
            retrying === "github"
              ? "siteEditor.retrying.github"
              : "siteEditor.retrying.sandbox",
          )}
        </p>
      )}
    </div>
  );
}
