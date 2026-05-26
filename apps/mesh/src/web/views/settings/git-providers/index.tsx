import { Suspense, useState } from "react";
import { AlertCircle, Plus } from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  useGitProviders,
  useGitInstallations,
} from "@/web/hooks/collections/use-git-providers";
import { GitProviderInstallDialog } from "./install-dialog";
import { GitProviderInstallationsList } from "./installations-list";
import { GitProviderUserLinkCard } from "./user-link-card";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load Git providers: {error.message}
      </span>
    </div>
  );
}

function OrgGitProvidersContent() {
  const providers = useGitProviders();
  const installations = useGitInstallations();
  const [installOpen, setInstallOpen] = useState(false);

  const github = providers.find((p) => p.id === "github");
  const hasAnyInstallation = installations.length > 0;

  if (!github?.available) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-center">
        <h3 className="text-sm font-medium">
          GitHub Git Provider not configured
        </h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          To enable this integration, set <code>DECOBOT_APP_ID</code>,{" "}
          <code>DECOBOT_PRIVATE_KEY</code>, <code>DECOBOT_CLIENT_ID</code>,{" "}
          <code>DECOBOT_CLIENT_SECRET</code>, and <code>DECOBOT_APP_SLUG</code>{" "}
          on the Studio server. Then restart the process.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!hasAnyInstallation ? (
        <div className="rounded-md border border-dashed border-border bg-card p-8 text-center">
          <img
            src={github.logo}
            alt=""
            width={48}
            height={48}
            className="mx-auto mb-3 opacity-80"
          />
          <h3 className="text-sm font-medium">Connect GitHub via Decobot</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Install the Decobot GitHub App on your organization so agents can
            read code, open issues, and comment on PRs — attributed to the
            actual user who triggered them.
          </p>
          <Button onClick={() => setInstallOpen(true)} className="mt-4 gap-2">
            <Plus size={14} />
            Install Decobot
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {installations.length}{" "}
              {installations.length === 1 ? "installation" : "installations"}{" "}
              connected.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInstallOpen(true)}
              className="gap-1.5"
            >
              <Plus size={14} />
              Add another
            </Button>
          </div>

          <GitProviderInstallationsList />
        </>
      )}

      <Suspense fallback={<Skeleton className="h-20 w-full rounded-md" />}>
        <GitProviderUserLinkCard />
      </Suspense>

      <GitProviderInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
      />
    </div>
  );
}

export function OrgGitProvidersPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Git Providers</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load Git providers")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <OrgGitProvidersContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
