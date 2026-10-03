/**
 * `/$org/connect` — the second half of a `deco serve` connect link (see
 * `routes/connect.tsx`): checks the server answers, then binds it to the
 * project the editor picks and opens that project's site editor.
 *
 * The first request to the server is what makes Chrome ask whether this site
 * may reach a server on the editor's machine (Local Network Access).
 */

import { Suspense } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { createContentClient } from "@decocms/shared/blocks-protocol";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { AgentAvatar } from "@/components/agent-icon";
import {
  clearPendingConnection,
  readPendingConnection,
} from "@/components/sections-editor/deco-serve-connection";
import { useSaveDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { scopableProjects } from "@/hooks/use-project-scope";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext, useVirtualMCPs } from "@/sdk";
import { decoServeErrorReason } from "@/components/sections-editor/deco-serve-status";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        {children}
      </div>
    </div>
  );
}

function ProjectPicker({
  onPick,
}: {
  onPick: (project: { id: string }) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const projects = scopableProjects(useVirtualMCPs({ pageSize: 1000 }))
    .filter((p) => p.id !== org.id)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("decoServe.connect.noProjects")}
      </p>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2">
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => onPick(project)}
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent"
        >
          <AgentAvatar icon={project.icon} name={project.title} size="sm" />
          <span className="truncate text-sm font-medium text-foreground">
            {project.title}
          </span>
        </button>
      ))}
    </div>
  );
}

export default function OrgConnectRoute() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const enabled = useOrgFlag("site_editor_content_protocol");
  const saveConnection = useSaveDecoServeConnection();
  const pending = readPendingConnection();

  const described = useQuery({
    queryKey: KEYS.contentBackend(
      "connect",
      pending?.endpoint ?? "",
      pending?.token ?? "",
    ),
    queryFn: () => createContentClient(pending!).describe(),
    enabled: enabled && !!pending,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (!enabled) {
    return (
      <Centered>
        <h1 className="text-lg font-medium text-foreground">
          {t("decoServe.connect.notEnabledTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.notEnabledDescription")}
        </p>
      </Centered>
    );
  }
  if (!pending) {
    return (
      <Centered>
        <h1 className="text-lg font-medium text-foreground">
          {t("decoServe.connect.invalidLinkTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.invalidLinkDescription")}
        </p>
      </Centered>
    );
  }
  if (described.isPending) {
    return (
      <Centered>
        <Spinner className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.reaching", { endpoint: pending.endpoint })}
        </p>
      </Centered>
    );
  }
  if (described.isError) {
    return (
      <Centered>
        <p role="alert" className="text-sm text-destructive">
          {decoServeErrorReason(described.error) === "unauthorized"
            ? t("decoServe.status.unauthorized")
            : t("decoServe.status.unreachable")}
        </p>
        <Button variant="outline" onClick={() => described.refetch()}>
          {t("decoServe.connect.retry")}
        </Button>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-medium text-foreground">
          {t("decoServe.connect.pickTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("decoServe.connect.pickDescription", {
            root: described.data.root,
            endpoint: pending.endpoint,
          })}
        </p>
      </div>
      <Suspense fallback={<Spinner className="size-5 text-muted-foreground" />}>
        <ProjectPicker
          onPick={(project) => {
            saveConnection(project.id, pending);
            clearPendingConnection();
            navigate({
              to: PROJECT_ROUTE.siteEditorContent,
              params: { org: org.slug, agentId: project.id },
            });
          }}
        />
      </Suspense>
    </Centered>
  );
}
