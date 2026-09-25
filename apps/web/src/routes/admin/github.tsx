import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Alert, AlertDescription } from "@decocms/ui/components/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Page } from "@/components/page";
import { EmptyState } from "@/components/empty-state.tsx";
import { adminFetch } from "@/lib/admin-fetch";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

interface GithubAppStatus {
  source: "env" | "stored" | null;
  usable: boolean;
  stored: {
    appId: string;
    slug: string;
    htmlUrl: string | null;
    ownerLogin: string | null;
    createdAt: string;
  } | null;
  defaultName: string;
  publicUrl: string;
}

type Key = Parameters<ReturnType<typeof useT>>[0];

/** `?github_app=` outcomes the manifest callback redirects back with. */
const OUTCOMES: Record<string, { ok: boolean; key: Key }> = {
  created: { ok: true, key: "admin.github.outcomeCreated" },
  denied: { ok: false, key: "admin.github.outcomeDenied" },
  invalid_state: { ok: false, key: "admin.github.outcomeInvalidState" },
  session_mismatch: { ok: false, key: "admin.github.outcomeSessionMismatch" },
  env_configured: { ok: false, key: "admin.github.outcomeEnvConfigured" },
  exchange_failed: { ok: false, key: "admin.github.outcomeExchangeFailed" },
};

/** The manifest callback's outcome, until dismissed. */
function OutcomeBanner() {
  const t = useT();
  const navigate = useNavigate();
  const outcome = useSearch({
    strict: false,
    select: (search) => search.github_app,
  });
  if (!outcome) return null;
  const known = OUTCOMES[outcome] ?? OUTCOMES.exchange_failed!;
  return (
    <Alert variant={known.ok ? "info" : "destructive"}>
      <AlertDescription className="flex-1">{t(known.key)}</AlertDescription>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigate({
            to: ".",
            search: (prev) => ({ ...prev, github_app: undefined }),
            replace: true,
          })
        }
      >
        {t("settings.repositories.dismiss")}
      </Button>
    </Alert>
  );
}

/**
 * GitHub's manifest flow starts with a browser form POST to github.com — not a
 * fetch — so GitHub can show its own "Create GitHub App" confirmation page.
 */
function submitManifest(action: string, manifest: string) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export default function AdminGithubPage() {
  const t = useT();
  const [organization, setOrganization] = useState("");
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: KEYS.deploymentAdminGithubApp(),
    queryFn: () => adminFetch<GithubAppStatus>("/api/_admin/github-app"),
  });

  const create = useMutation({
    mutationFn: () =>
      adminFetch<{ action: string; manifest: string }>(
        "/api/_admin/github-app/manifest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organization: organization.trim() || undefined,
            name: name.trim() || undefined,
            public: isPublic,
          }),
        },
      ),
    onSuccess: ({ action, manifest }) => submitManifest(action, manifest),
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("admin.github.createFailed"),
      );
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      adminFetch<{ ok: true }>("/api/_admin/github-app", { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("admin.github.removed"));
      refetch();
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : t("admin.github.removeFailed"),
      );
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState
        title={t("admin.github.failedToLoad")}
        description={error instanceof Error ? error.message : ""}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t("admin.prompts.retry")}
          </Button>
        }
      />
    );
  }

  const installUrl = data.stored
    ? `https://github.com/apps/${encodeURIComponent(data.stored.slug)}/installations/new`
    : null;

  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <div className="flex max-w-xl flex-col gap-6">
            <OutcomeBanner />
            <p className="text-sm text-muted-foreground">
              {t("admin.github.description")}
            </p>

            {data.source === "env" ? (
              <div className="rounded-xl border border-border p-4 text-sm">
                <p className="font-medium">{t("admin.github.envTitle")}</p>
                <p className="mt-1 text-muted-foreground">
                  {t(
                    data.usable
                      ? "admin.github.envDescription"
                      : "admin.github.envUnusable",
                  )}
                </p>
              </div>
            ) : null}

            {data.source === "stored" && data.stored ? (
              <div className="flex flex-col gap-3 rounded-xl border border-border p-4 text-sm">
                <div>
                  <p className="font-medium">
                    {t("admin.github.storedTitle", { slug: data.stored.slug })}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {t(
                      data.usable
                        ? "admin.github.storedDescription"
                        : "admin.github.storedUnusable",
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {installUrl ? (
                    <Button size="sm" asChild>
                      <a href={installUrl} target="_blank" rel="noreferrer">
                        {t("admin.github.install")}
                      </a>
                    </Button>
                  ) : null}
                  {data.stored.htmlUrl ? (
                    <Button size="sm" variant="outline" asChild>
                      <a
                        href={data.stored.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("admin.github.viewOnGithub")}
                      </a>
                    </Button>
                  ) : null}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                      >
                        {t("admin.github.remove")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("admin.github.removeTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("admin.github.removeDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>
                          {t("admin.github.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction onClick={() => remove.mutate()}>
                          {t("admin.github.remove")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ) : null}

            {data.source !== "env" ? (
              <div className="flex flex-col gap-4">
                <p className="text-sm font-medium">
                  {t(
                    data.source === "stored"
                      ? "admin.github.replaceTitle"
                      : "admin.github.createTitle",
                  )}
                </p>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="github-app-org">
                    {t("admin.github.organizationLabel")}
                  </Label>
                  <Input
                    id="github-app-org"
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                    placeholder={t("admin.github.organizationPlaceholder")}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("admin.github.organizationHint")}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="github-app-name">
                    {t("admin.github.nameLabel")}
                  </Label>
                  <Input
                    id="github-app-name"
                    value={name}
                    maxLength={34}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={data.defaultName}
                  />
                </div>
                <div className="flex items-start gap-3">
                  <Switch
                    id="github-app-public"
                    checked={isPublic}
                    onCheckedChange={setIsPublic}
                  />
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="github-app-public">
                      {t("admin.github.publicLabel")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("admin.github.publicHint")}
                    </p>
                  </div>
                </div>
                <div>
                  <Button
                    disabled={create.isPending}
                    onClick={() => create.mutate()}
                  >
                    {create.isPending
                      ? t("admin.github.redirecting")
                      : t(
                          data.source === "stored"
                            ? "admin.github.replace"
                            : "admin.github.create",
                        )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("admin.github.publicUrlNote", { url: data.publicUrl })}
                </p>
              </div>
            ) : null}
          </div>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
