import { Suspense } from "react";
import { AlertCircle, Key01 } from "@untitledui/icons";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import { Page } from "@/components/page";
import { SettingsPage } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import type { ApiKey } from "@/hooks/use-api-keys";
import { useApiKeysList } from "@/hooks/use-api-keys";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load API keys: {error.message}
      </span>
    </div>
  );
}

function ApiKeyRow({ apiKey }: { apiKey: ApiKey }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Key01 size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <span className="font-medium text-sm truncate">{apiKey.name}</span>
        </div>
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {new Date(apiKey.createdAt).toLocaleDateString()}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <Key01 size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">No API keys yet</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Create API keys to access Studio programmatically from scripts and
          automation tools.
        </p>
      </div>
    </div>
  );
}

function ApiKeysContent() {
  const { data: keys, isLoading } = useApiKeysList();

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (!keys || keys.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {keys.map((apiKey) => (
        <ApiKeyRow key={apiKey.id} apiKey={apiKey} />
      ))}
    </div>
  );
}

export function OrgApiKeysPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.nav.apiKeys")}</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load API keys")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <ApiKeysContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
