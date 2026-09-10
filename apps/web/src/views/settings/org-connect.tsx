/**
 * Settings › Connect to clients — how a person points Claude, Cursor or Codex
 * at this org's MCP endpoint, and every API key that endpoint accepts.
 *
 * Flat by design: client tabs, the selected client's snippet, then the API
 * keys section (`views/settings/api-keys.tsx`, also the whole of the
 * `/settings/api-keys` route). The last client tab, "Other", is the general
 * case — the bare endpoint URL for a client this page does not list — so the
 * URL appears in exactly one place instead of a card of its own.
 *
 * The keys section lists every key in the org, so a key minted here by
 * "Generate key" shows up under its stored name and revokes from the same
 * list; there is no second, filtered copy of it on this page.
 *
 * The OAuth / API-key choice is one page-level `Select` living on the snippet
 * it governs. It used to be a tab strip inside each client panel, so choosing
 * "API key" and then switching from Cursor to Codex silently reverted to OAuth.
 */

import { type ComponentType, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { useProjectContext } from "@/sdk";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy01,
  Key01,
  Link01,
} from "@untitledui/icons";
import { ClaudeCodeIcon, CodexIcon } from "@/components/chat/agent-icons";
import { CursorIcon } from "@/components/connect/client-icons";
import {
  type ConnectClient,
  type ConnectMode,
  InstallSnippet,
} from "@/components/connect/install-snippet";
import { mcpUrl } from "@/components/connect/mcp-url";
import { useApiKeysList, useCreateApiKey } from "@/hooks/use-api-keys";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import { SettingsSection } from "@/components/settings/settings-section";
import { RequireCapability } from "@/components/require-capability";
import { useCapability } from "@/hooks/use-capability";
import { ApiKeysSection } from "@/views/settings/api-keys";

const KEY_NAME_PREFIX = "Connect: ";

/** A key minted on this page: `at` is when, so a stale list can't hide it. */
interface Minted {
  id: string;
  key: string;
  at: number;
}

/**
 * Brand names are never translated, so `label` doubles as the English name
 * minted into the API key. Only the non-brand entry ("Other") carries a
 * `labelKey`, and only for display.
 */
const CLIENTS: {
  id: ConnectClient;
  label: string;
  labelKey?: TranslationKey;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { id: "claude-code", label: "Claude", Icon: ClaudeCodeIcon },
  { id: "cursor", label: "Cursor", Icon: CursorIcon },
  { id: "codex", label: "Codex", Icon: CodexIcon },
  {
    id: "raw",
    label: "Other client",
    labelKey: "settings.connectClients.otherClient",
    Icon: Link01,
  },
];

function clientLabel(id: ConnectClient): string {
  return CLIENTS.find((c) => c.id === id)?.label ?? id;
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
      aria-label={t("settings.connectClients.copy")}
    >
      {copied ? <Check size={14} /> : <Copy01 size={14} />}
    </Button>
  );
}

/**
 * Where a client that speaks MCP OAuth 2.1 discovers the auth flow. The
 * protected-resource metadata is served at the MCP endpoint itself
 * (`/api/:org/mcp/self/.well-known/oauth-protected-resource`), not the origin
 * root — that's the path the 401 WWW-Authenticate header points at.
 */
function OAuthDiscovery({ url }: { url: string }) {
  const t = useT();
  const metadataUrl = `${url}/.well-known/oauth-protected-resource`;
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {t("settings.connectClients.oauthDiscoveryDetails")}
      </summary>
      <div className="mt-2 space-y-1 pl-[18px]">
        <p>{t("settings.connectClients.oauthMetadataHint")}</p>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5">
          <code className="flex-1 truncate font-mono text-[11px]">
            {metadataUrl}
          </code>
          <CopyInline text={metadataUrl} />
        </div>
      </div>
    </details>
  );
}

/**
 * The one OAuth / API-key control on the page. It sits beside the client tabs
 * because the two choices decide the same thing together: tabs pick which
 * client, this picks which method, the snippet below is the result of both.
 */
function ModeSelect({
  mode,
  onModeChange,
}: {
  mode: ConnectMode;
  onModeChange: (mode: ConnectMode) => void;
}) {
  const t = useT();
  return (
    <Select
      value={mode}
      onValueChange={(value) => {
        if (value === "oauth" || value === "api-key") onModeChange(value);
      }}
    >
      <SelectTrigger
        size="sm"
        className="text-xs"
        aria-label={t("settings.connectClients.installMethod")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="oauth" className="text-xs">
          {t("settings.connectClients.oauthOption")}
        </SelectItem>
        <SelectItem value="api-key" className="text-xs">
          {t("settings.connectClients.apiKeyOption")}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

/** One client's snippet, plus the key actions the API-key method needs. */
function ClientPanel({
  client,
  url,
  mode,
  newKey,
  canManageKeys,
  onGenerate,
  isGenerating,
  onClearNewKey,
}: {
  client: ConnectClient;
  url: string;
  mode: ConnectMode;
  newKey: string | null;
  /** Minting a key is `api-keys:manage`; the snippet itself is not. */
  canManageKeys: boolean;
  onGenerate: () => void;
  isGenerating: boolean;
  onClearNewKey: () => void;
}) {
  const t = useT();
  const showsKey = mode === "api-key" && newKey !== null;
  const isOther = client === "raw";

  return (
    <div className="flex flex-col gap-3">
      {showsKey && (
        <Alert variant="warning" className="text-xs">
          <AlertTriangle />
          <AlertDescription>
            {t("settings.connectClients.snippetOneTimeWarning")}
          </AlertDescription>
        </Alert>
      )}
      <InstallSnippet
        client={client}
        mode={mode}
        url={url}
        apiKey={showsKey && newKey ? newKey : undefined}
      />
      {isOther && <OAuthDiscovery url={url} />}
      {mode === "api-key" && canManageKeys && (
        <div>
          {showsKey ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearNewKey}
              className="text-xs"
            >
              {t("settings.connectClients.doneHideKey")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={onGenerate}
              disabled={isGenerating}
              className="gap-1.5"
            >
              <Key01 size={14} />
              {isGenerating
                ? t("settings.connectClients.generatingKey")
                : isOther
                  ? t("settings.connectClients.generateKey")
                  : t("settings.connectClients.generateKeyFor", {
                      client: clientLabel(client),
                    })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function OrgConnectContent() {
  const t = useT();
  const { org } = useProjectContext();
  const url = mcpUrl(org.slug);
  const createKey = useCreateApiKey();
  const { granted: canManageKeys } = useCapability("api-keys:manage");
  const { data: orgKeys, dataUpdatedAt: keysUpdatedAt } = useApiKeysList({
    enabled: canManageKeys,
  });
  const [mode, setMode] = useState<ConnectMode>("oauth");
  const [newKeys, setNewKeys] = useState<
    Partial<Record<ConnectClient, Minted>>
  >({});

  /**
   * The keys list below is the only record of what still exists, so a key
   * minted here disappears from the snippet as soon as it is revoked there. A
   * list snapshot older than the mint can't prove a revocation, so it hides
   * nothing.
   */
  const liveKey = (client: ConnectClient): string | null => {
    const minted = newKeys[client];
    if (!minted) return null;
    if (!orgKeys || keysUpdatedAt < minted.at) return minted.key;
    return orgKeys.some((k) => k.id === minted.id) ? minted.key : null;
  };

  const [client, setClient] = useState<ConnectClient>("claude-code");
  /** Narrow rather than cast: Tabs hands back a bare string. */
  const selectClient = (value: string) => {
    const next = CLIENTS.find((c) => c.id === value);
    if (next) setClient(next.id);
  };

  const handleGenerate = (client: ConnectClient) => {
    const name = `${KEY_NAME_PREFIX}${clientLabel(client)} on ${hostnameLabel()}`;
    createKey.mutate(
      { name, permissions: { "*": ["*"] } },
      {
        onSuccess: (key) => {
          setNewKeys((prev) => ({
            ...prev,
            [client]: { id: key.id, key: key.key, at: Date.now() },
          }));
          toast.success(t("settings.connectClients.keyCreated"));
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <>
      <SettingsSection
        headerClassName="px-0"
        title={t("settings.connectClients.connectAClient")}
      >
        <Card className="gap-0 overflow-hidden p-0">
          <Tabs
            value={client}
            onValueChange={selectClient}
            variant="underline"
            className="gap-0"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
              <TabsList
                variant="underline"
                className="h-10 min-w-0 flex-1 gap-1 overflow-x-auto border-b-0"
              >
                {CLIENTS.map(({ id, label, labelKey, Icon }) => (
                  <TabsTrigger
                    key={id}
                    value={id}
                    variant="underline"
                    className="gap-2"
                  >
                    <Icon size={16} />
                    {labelKey ? t(labelKey) : label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <ModeSelect mode={mode} onModeChange={setMode} />
            </div>

            {CLIENTS.map(({ id, label }) => (
              <TabsContent key={id} value={id} className="p-2">
                <ClientPanel
                  client={id}
                  url={url}
                  mode={mode}
                  newKey={liveKey(id)}
                  canManageKeys={canManageKeys}
                  onGenerate={() => handleGenerate(id)}
                  isGenerating={
                    createKey.isPending &&
                    createKey.variables?.name?.startsWith(
                      `${KEY_NAME_PREFIX}${label}`,
                    ) === true
                  }
                  onClearNewKey={() =>
                    setNewKeys((prev) => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    })
                  }
                />
              </TabsContent>
            ))}
          </Tabs>
        </Card>
        {/* Outside the card: these describe the CHOICES above (method, and the
            Other client), not the snippet the card is showing. */}
        <p className="text-xs leading-snug text-muted-foreground">
          {mode === "oauth"
            ? t("settings.connectClients.oauthKeyHint")
            : t("settings.connectClients.headlessKeyHint")}
        </p>
        {client === "raw" && (
          <p className="text-xs leading-snug text-muted-foreground">
            {t("settings.connectClients.anyOtherClientDescription")}
          </p>
        )}
      </SettingsSection>

      <RequireCapability capability="api-keys:manage" area="api-keys">
        <ApiKeysSection />
      </RequireCapability>
    </>
  );
}

export function OrgConnectPage() {
  return (
    <SettingsGroupPage group="connect">
      <OrgConnectContent />
    </SettingsGroupPage>
  );
}
