import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@deco/ui/components/alert.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@deco/ui/components/tabs.tsx";
import { useCopy } from "@deco/ui/hooks/use-copy.ts";
import { useProjectContext } from "@/sdk";
import {
  AlertTriangle,
  Check,
  Copy01,
  Key01,
  LinkExternal01,
  Trash01,
} from "@untitledui/icons";
import { Page } from "@/components/page";
import { SettingsPage } from "@/components/settings/settings-section";
import {
  type ConnectClient,
  InstallSnippet,
} from "@/components/connect/install-snippet";
import { mcpUrl } from "@/components/connect/mcp-url";
import {
  useApiKeysList,
  useCreateApiKey,
  useDeleteApiKey,
} from "@/hooks/use-api-keys";
import { useT, type TFunction, type TranslationKey } from "@/i18n/use-t";

const KEY_NAME_PREFIX = "Connect: ";

const CLIENTS: { id: ConnectClient; labelKey: TranslationKey }[] = [
  { id: "claude-code", labelKey: "settings.orgConnect.clientClaudeCode" },
  { id: "cursor", labelKey: "settings.orgConnect.clientCursor" },
  { id: "codex", labelKey: "settings.orgConnect.clientCodex" },
  { id: "claude-desktop", labelKey: "settings.orgConnect.clientClaudeDesktop" },
  { id: "raw", labelKey: "settings.orgConnect.clientRawUrl" },
];

function clientLabel(t: TFunction, id: ConnectClient): string {
  const key = CLIENTS.find((c) => c.id === id)?.labelKey;
  return key ? t(key) : id;
}

function hostnameLabel(): string {
  if (typeof window === "undefined") return "unknown";
  return window.location.hostname;
}

function CopyInline({ text }: { text: string }) {
  const t = useT();
  const { handleCopy, copied } = useCopy();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      onClick={() => handleCopy(text)}
      aria-label={t("settings.orgConnect.copyLabel")}
    >
      {copied ? <Check size={14} /> : <Copy01 size={14} />}
    </Button>
  );
}

function ClientPanel({
  client,
  url,
  newKey,
  onGenerate,
  isGenerating,
  onClearNewKey,
}: {
  client: ConnectClient;
  url: string;
  newKey: string | null;
  onGenerate: () => void;
  isGenerating: boolean;
  onClearNewKey: () => void;
}) {
  const t = useT();
  return (
    <Tabs defaultValue="oauth" className="mt-4">
      <TabsList>
        <TabsTrigger value="oauth">
          {t("settings.orgConnect.oauthTab")}
        </TabsTrigger>
        <TabsTrigger value="api-key">
          {t("settings.orgConnect.apiKeyTab")}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="oauth" className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.orgConnect.oauthTabDescription")}
        </p>
        <InstallSnippet client={client} mode="oauth" url={url} />
      </TabsContent>

      <TabsContent value="api-key" className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.orgConnect.apiKeyTabDescription")}
        </p>
        {newKey ? (
          <>
            <Alert variant="warning" className="text-xs">
              <AlertTriangle />
              <AlertDescription>
                {t("settings.orgConnect.newKeyWarning")}
              </AlertDescription>
            </Alert>
            <InstallSnippet
              client={client}
              mode="api-key"
              url={url}
              apiKey={newKey}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearNewKey}
              className="text-xs"
            >
              {t("settings.orgConnect.doneHideKey")}
            </Button>
          </>
        ) : (
          <>
            <InstallSnippet client={client} mode="api-key" url={url} />
            <Button
              size="sm"
              onClick={onGenerate}
              disabled={isGenerating}
              className="gap-1.5"
            >
              <Key01 size={14} />
              {isGenerating
                ? t("settings.orgConnect.generating")
                : t("settings.orgConnect.generateKeyFor", {
                    client: clientLabel(t, client),
                  })}
            </Button>
          </>
        )}
      </TabsContent>
    </Tabs>
  );
}

function ConnectKeysList() {
  const t = useT();
  const { data, isLoading, error } = useApiKeysList();
  const deleteKey = useDeleteApiKey();

  const connectKeys =
    data?.filter((k) => k.name.startsWith(KEY_NAME_PREFIX)) ?? [];

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("settings.orgConnect.loadingActiveKeys")}
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-xs text-destructive">
        {t("settings.orgConnect.failedToLoadKeys", { error: error.message })}
      </p>
    );
  }

  if (connectKeys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("settings.orgConnect.noConnectKeys")}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {connectKeys.map((key) => (
        <li
          key={key.id}
          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">
              {key.name.replace(KEY_NAME_PREFIX, "")}
            </div>
            <div className="text-muted-foreground">
              {t("settings.orgConnect.createdOn", {
                date: new Date(key.createdAt).toLocaleDateString(),
              })}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (
                confirm(
                  t("settings.orgConnect.confirmRevoke", { name: key.name }),
                )
              ) {
                deleteKey.mutate(key.id, {
                  onSuccess: () =>
                    toast.success(t("settings.orgConnect.keyRevoked")),
                  onError: (e) => toast.error(e.message),
                });
              }
            }}
            disabled={deleteKey.isPending}
            className="gap-1 text-destructive hover:text-destructive"
          >
            <Trash01 size={14} />
            {t("settings.orgConnect.revoke")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function OrgConnectPage() {
  const t = useT();
  const { org } = useProjectContext();
  const url = mcpUrl(org.slug);
  const createKey = useCreateApiKey();
  const [newKeys, setNewKeys] = useState<
    Partial<Record<ConnectClient, string>>
  >({});

  const handleGenerate = (client: ConnectClient) => {
    const name = `${KEY_NAME_PREFIX}${clientLabel(t, client)} on ${hostnameLabel()}`;
    createKey.mutate(
      { name, permissions: { "*": ["*"] } },
      {
        onSuccess: (key) => {
          setNewKeys((prev) => ({ ...prev, [client]: key.key }));
          toast.success(t("settings.orgConnect.keyCreated"));
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  // Protected-resource metadata is served at the aggregate MCP endpoint itself
  // (`/api/:org/mcp/.well-known/oauth-protected-resource`), not the origin root
  // — that's the path clients discover from the 401 WWW-Authenticate header.
  const oauthMetadataUrl = `${url}/.well-known/oauth-protected-resource`;

  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.orgConnect.pageTitle")}</Page.Title>

            <Card className="p-5 gap-3">
              <div className="flex items-start gap-3">
                <div className="size-9 rounded-lg bg-muted/60 flex items-center justify-center text-muted-foreground shrink-0">
                  <LinkExternal01 size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-medium leading-tight">
                    {t("settings.orgConnect.unifiedMcpTitle")}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-1 leading-snug">
                    {t("settings.orgConnect.unifiedMcpDescription")}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5">
                <code className="text-xs flex-1 truncate">{url}</code>
                <CopyInline text={url} />
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer hover:text-foreground">
                  {t("settings.orgConnect.wiringCustomClient")}
                </summary>
                <div className="mt-2 space-y-1">
                  <p>{t("settings.orgConnect.oauthMetadataAdvertised")}</p>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
                    <code className="text-[11px] flex-1 truncate">
                      {oauthMetadataUrl}
                    </code>
                    <CopyInline text={oauthMetadataUrl} />
                  </div>
                </div>
              </details>
            </Card>

            <Tabs defaultValue="claude-code" variant="underline">
              <TabsList variant="underline">
                {CLIENTS.map((c) => (
                  <TabsTrigger key={c.id} value={c.id} variant="underline">
                    {t(c.labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>

              {CLIENTS.map((c) => (
                <TabsContent key={c.id} value={c.id}>
                  <ClientPanel
                    client={c.id}
                    url={url}
                    newKey={newKeys[c.id] ?? null}
                    onGenerate={() => handleGenerate(c.id)}
                    isGenerating={
                      createKey.isPending &&
                      createKey.variables?.name?.startsWith(
                        `${KEY_NAME_PREFIX}${t(c.labelKey)}`,
                      ) === true
                    }
                    onClearNewKey={() =>
                      setNewKeys((prev) => {
                        const next = { ...prev };
                        delete next[c.id];
                        return next;
                      })
                    }
                  />
                </TabsContent>
              ))}
            </Tabs>

            <section className="flex flex-col gap-3">
              <div className="px-4">
                <h2 className="text-[15px] font-medium leading-tight">
                  {t("settings.orgConnect.activeKeysTitle")}
                </h2>
                <p className="text-sm text-muted-foreground leading-snug mt-1">
                  {t("settings.orgConnect.activeKeysDescription")}
                </p>
              </div>
              <ConnectKeysList />
            </section>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
