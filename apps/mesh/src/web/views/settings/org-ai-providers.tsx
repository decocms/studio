import { Suspense, useState, useEffect } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  Trash01,
  Key01,
  AlertCircle,
  Edit01,
  Check,
  X,
} from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@deco/ui/components/dialog.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import {
  useAiProviders,
  useAiProviderKeys,
  type AiProviderKey,
} from "@/web/hooks/collections/use-ai-providers";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { track } from "@/web/lib/posthog-client";
import { cn } from "@deco/ui/lib/utils.ts";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
} from "@/web/utils/openai-compatible-presets";
import { SimpleModeSection } from "./ai-providers/simple-mode-section";
import { DecoCreditsHero } from "./ai-providers/deco-credits-hero";
import {
  ConnectApiKeyForm,
  ConnectOpenAICompatibleForm,
} from "./ai-providers/connect-forms";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load AI providers: {error.message}
      </span>
    </div>
  );
}

function KeyList({
  keys,
  onDelete,
  isDeleting,
}: {
  keys: AiProviderKey[];
  onDelete: (keyId: string) => void;
  isDeleting: boolean;
}) {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const targetKey = keys.find((k) => k.id === deleteTarget);

  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { mutate: updateLabel, isPending: isUpdating } = useMutation({
    mutationFn: async ({ keyId, label }: { keyId: string; label: string }) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_UPDATE",
        arguments: { keyId, label },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      setEditTarget(null);
    },
    onError: () => {
      toast.error("Failed to update key label");
    },
  });

  const startEdit = (key: AiProviderKey) => {
    setEditTarget(key.id);
    setEditLabel(key.label);
  };

  const cancelEdit = () => {
    setEditTarget(null);
    setEditLabel("");
  };

  const confirmEdit = (keyId: string) => {
    const trimmed = editLabel.trim();
    if (!trimmed) return;
    updateLabel({ keyId, label: trimmed });
  };

  return (
    <div className="flex flex-col gap-2 mt-4">
      {keys.map((key) => (
        <div
          key={key.id}
          className="flex items-center justify-between p-2 rounded-md bg-muted/50 text-sm"
        >
          <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
            <Key01 size={14} className="text-muted-foreground shrink-0" />
            {editTarget === key.id ? (
              <input
                autoFocus
                className="font-medium bg-transparent border-b border-border outline-none flex-1 min-w-0"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmEdit(key.id);
                  if (e.key === "Escape") cancelEdit();
                }}
              />
            ) : (
              <>
                <span className="font-medium truncate">{key.label}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  added {formatDistanceToNow(new Date(key.createdAt))} ago
                </span>
              </>
            )}
          </div>
          {/* Stop propagation so clicks don't trigger card's onClick */}
          <div
            className="flex items-center gap-0.5 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {editTarget === key.id ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  disabled={isUpdating || !editLabel.trim()}
                  onClick={() => confirmEdit(key.id)}
                >
                  <Check size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={cancelEdit}
                >
                  <X size={14} />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  onClick={() => startEdit(key)}
                >
                  <Edit01 size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  disabled={isDeleting}
                  onClick={() => setDeleteTarget(key.id)}
                >
                  <Trash01 size={14} />
                </Button>
              </>
            )}
          </div>
        </div>
      ))}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API Key</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {targetKey?.label}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) {
                  onDelete(deleteTarget);
                  setDeleteTarget(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export type AiProvider = {
  id: string;
  name: string;
  description: string;
  logo?: string | null;
  connectionMethod?: "api-key" | "oauth-pkce" | "cli-activate";
  supportedMethods: ("api-key" | "oauth-pkce" | "cli-activate")[];
  supportsTopUp?: boolean;
  supportsCredits?: boolean;
  supportsProvision?: boolean;
};

function ProviderCard({
  provider,
  keys,
}: {
  provider: AiProvider;
  keys: AiProviderKey[];
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const [isConnectFormOpen, setIsConnectFormOpen] = useState(false);
  const [isOAuthPending, setIsOAuthPending] = useState(false);
  const [oauthStateToken, setOauthStateToken] = useState<string | null>(null);
  const isCliActivate = provider.supportedMethods.includes("cli-activate");
  const isActive = keys.length > 0;

  const { mutate: deleteKey, isPending: isDeleting } = useMutation({
    mutationFn: async (keyId: string) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId },
      });
      return keyId;
    },
    onSuccess: (deletedKeyId) => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderModels(org.id, deletedKeyId),
      });
      toast.success("Key deleted");
    },
    onError: (err) => {
      toast.error(`Failed to delete key: ${err.message}`);
    },
  });

  const { mutate: exchangeOAuth } = useMutation({
    mutationFn: async ({
      code,
      stateToken,
    }: {
      code: string;
      stateToken: string;
    }) => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_OAUTH_EXCHANGE",
        arguments: {
          providerId: provider.id,
          code,
          stateToken,
          label: provider.name,
        },
      })) as { isError?: boolean; content?: { text?: string }[] };
      if (result?.isError) {
        const msg = result.content?.[0]?.text ?? "OAuth exchange failed";
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      track("ai_provider_oauth_succeeded", { provider_id: provider.id });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success(`${provider.name} connected successfully`);
      setIsOAuthPending(false);
      setOauthStateToken(null);
    },
    onError: (err) => {
      track("ai_provider_oauth_failed", {
        provider_id: provider.id,
        error: err.message,
      });
      toast.error(`OAuth connection failed: ${err.message}`);
      setIsOAuthPending(false);
      setOauthStateToken(null);
    },
  });

  const { mutate: activateCli, isPending: isActivating } = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_CLI_ACTIVATE",
        arguments: { providerId: provider.id },
      })) as {
        structuredContent?: { activated: boolean; error?: string };
        isError?: boolean;
        content?: { text?: string }[];
      };
      if (result?.isError) {
        throw new Error(result.content?.[0]?.text ?? "CLI activation failed");
      }
      return result.structuredContent;
    },
    onSuccess: (data) => {
      if (!data?.activated) {
        track("ai_provider_cli_activate_failed", {
          provider_id: provider.id,
          error: data?.error ?? "unknown",
        });
        toast.error(data?.error ?? "CLI activation failed");
        return;
      }
      track("ai_provider_cli_activated", { provider_id: provider.id });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderKeys(org.id),
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviders(org.id),
      });
      toast.success(`${provider.name} activated`);
    },
    onError: (err) => {
      track("ai_provider_cli_activate_failed", {
        provider_id: provider.id,
        error: err.message,
      });
      toast.error(err.message);
    },
  });

  const { mutate: provisionKey, isPending: isProvisioning } = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_PROVISION_KEY",
        arguments: { providerId: provider.id },
      })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      if (result?.isError) {
        const msg = result.content?.[0]?.text ?? "Key provisioning failed";
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      track("ai_provider_provision_succeeded", {
        provider_id: provider.id,
      });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success(`${provider.name} connected successfully`);
    },
    onError: (err) => {
      track("ai_provider_provision_failed", {
        provider_id: provider.id,
        error: err.message,
      });
      toast.error(`Failed to connect ${provider.name}: ${err.message}`);
    },
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!isOAuthPending || !oauthStateToken) return;

    // Local flag — once the popup posts back and exchangeOAuth starts, the
    // exchange has its own onSuccess/onError handlers. Without this, a slow
    // exchange (>2min) would race the timeout and fire a false-positive
    // ai_provider_oauth_failed{error:"timeout"} alongside the eventual
    // ai_provider_oauth_succeeded.
    let exchangeStarted = false;

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "AI_PROVIDER_OAUTH_CALLBACK") {
        const { code, stateToken } = event.data;
        if (stateToken === oauthStateToken) {
          exchangeStarted = true;
          exchangeOAuth({ code, stateToken });
        } else {
          console.error("State token mismatch");
          toast.error("Security check failed: State token mismatch");
          setIsOAuthPending(false);
          setOauthStateToken(null);
        }
      }
    };

    window.addEventListener("message", handleMessage);

    // 2-minute popup-wait timeout. Distinct from exchange-failure: this means
    // the user never came back from the OAuth popup. Tracked as a separate
    // event so funnel math stays clean.
    const timeoutId = setTimeout(() => {
      if (exchangeStarted) return;
      track("ai_provider_oauth_timeout", { provider_id: provider.id });
      setIsOAuthPending(false);
      setOauthStateToken(null);
      toast.error("Connection timed out");
    }, 120000);

    return () => {
      window.removeEventListener("message", handleMessage);
      clearTimeout(timeoutId);
    };
  }, [isOAuthPending, oauthStateToken, exchangeOAuth, provider.id]);

  const supportsProvision = !!provider.supportsProvision;
  const supportsOAuth = provider.supportedMethods.includes("oauth-pkce");
  const supportsApiKey = provider.supportedMethods.includes("api-key");

  const handleCardClick = () => {
    if (isConnectFormOpen || isOAuthPending || isActivating || isProvisioning)
      return;
    if (isCliActivate) {
      if (!isActive) {
        track("ai_provider_connect_clicked", {
          provider_id: provider.id,
          method: "cli-activate",
        });
        activateCli();
      }
      return;
    }
    if (supportsProvision) {
      track("ai_provider_connect_clicked", {
        provider_id: provider.id,
        method: "provision",
      });
      provisionKey();
    } else if (supportsOAuth) {
      track("ai_provider_connect_clicked", {
        provider_id: provider.id,
        method: "oauth-pkce",
      });
      handleConnectOAuth();
    } else if (supportsApiKey) {
      track("ai_provider_connect_clicked", {
        provider_id: provider.id,
        method: "api-key",
      });
      setIsConnectFormOpen(true);
    }
  };

  const handleConnectOAuth = async () => {
    try {
      setIsOAuthPending(true);
      const result = (await client.callTool({
        name: "AI_PROVIDER_OAUTH_URL",
        arguments: {
          providerId: provider.id,
          callbackUrl: `${window.location.origin}/oauth/callback/ai-provider`,
        },
      })) as { structuredContent?: { url: string; stateToken: string } };

      if (result.structuredContent) {
        setOauthStateToken(result.structuredContent.stateToken);
        window.open(
          result.structuredContent.url,
          "AiProviderOAuth",
          "width=600,height=700",
        );
      } else {
        throw new Error("Invalid response from AI_PROVIDER_OAUTH_URL");
      }
    } catch (err) {
      setIsOAuthPending(false);
      toast.error(
        `Failed to start OAuth: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const loadingText = isActivating
    ? "Checking CLI..."
    : isProvisioning
      ? "Connecting..."
      : isOAuthPending
        ? "Authorizing..."
        : null;

  const statusText =
    loadingText ??
    (isActive && isCliActivate
      ? `Authenticated via ${provider.name} CLI`
      : provider.description);

  return (
    <>
      <SettingsCardItem
        icon={
          provider.logo ? (
            <img
              src={provider.logo}
              alt={provider.name}
              className="size-8 rounded-md object-contain dark:bg-white dark:p-0.5"
            />
          ) : (
            <Avatar
              fallback={provider.name.charAt(0)}
              className="size-8 bg-primary/10 text-primary"
            />
          )
        }
        title={
          <span className="flex items-center gap-2">
            {provider.name}
            {isActive && !isCliActivate && !loadingText && (
              <span className="text-xs font-normal text-muted-foreground">
                {keys.length} key{keys.length !== 1 ? "s" : ""} configured
                {provider.supportsCredits ? " · Managed above" : ""}
              </span>
            )}
          </span>
        }
        description={statusText}
        onClick={
          !isOAuthPending && !isActivating && !isProvisioning
            ? handleCardClick
            : undefined
        }
        className={cn(
          (isOAuthPending || isActivating || isProvisioning) && "cursor-wait",
        )}
        action={
          <div className="flex items-center gap-2">
            {isActive && (
              <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            )}
          </div>
        }
      >
        {isActive && !isCliActivate && (
          <KeyList keys={keys} onDelete={deleteKey} isDeleting={isDeleting} />
        )}
      </SettingsCardItem>

      <Dialog
        open={isConnectFormOpen}
        onOpenChange={(open) => {
          if (!open) setIsConnectFormOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {provider.name}</DialogTitle>
            <DialogDescription>
              {provider.id === "openai-compatible"
                ? "Enter the base URL and optional API key for your OpenAI-compatible endpoint."
                : `Add an API key to connect your ${provider.name} account.`}
            </DialogDescription>
          </DialogHeader>
          {provider.id === "openai-compatible" ? (
            <ConnectOpenAICompatibleForm
              onCancel={() => setIsConnectFormOpen(false)}
              onSuccess={() => setIsConnectFormOpen(false)}
            />
          ) : (
            <ConnectApiKeyForm
              providerId={provider.id}
              onCancel={() => setIsConnectFormOpen(false)}
              onSuccess={() => setIsConnectFormOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Card for an OpenAI-compatible "preset" (LiteLLM, Ollama, ...) or the generic
 * Custom fallback (preset = null). All keys are stored under
 * providerId="openai-compatible"; the preset_id column distinguishes them so
 * users can configure many of each.
 */
function OpenAICompatiblePresetCard({
  preset,
  keys,
  fallbackLogo,
}: {
  preset: OpenAICompatiblePreset | null;
  keys: AiProviderKey[];
  /** Used for the Custom (preset = null) card — shows the openai-compatible provider's default logo. */
  fallbackLogo?: string | null;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const isActive = keys.length > 0;

  const displayName = preset?.name ?? "Custom OpenAI Compatible";
  const description =
    preset?.description ?? "Connect any OpenAI-compatible endpoint by URL";
  const logo = preset?.logo ?? fallbackLogo;

  const { mutate: deleteKey, isPending: isDeleting } = useMutation({
    mutationFn: async (keyId: string) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId },
      });
      return keyId;
    },
    onSuccess: (deletedKeyId) => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderModels(org.id, deletedKeyId),
      });
      toast.success("Connection deleted");
    },
    onError: (err) => {
      toast.error(`Failed to delete connection: ${err.message}`);
    },
  });

  return (
    <>
      <SettingsCardItem
        icon={
          logo ? (
            <img
              src={logo}
              alt={displayName}
              className="size-8 rounded-md object-contain dark:bg-white dark:p-0.5"
            />
          ) : (
            <Avatar
              fallback={displayName.charAt(0)}
              className="size-8 bg-primary/10 text-primary"
            />
          )
        }
        title={
          <span className="flex items-center gap-2">
            {displayName}
            {isActive && (
              <span className="text-xs font-normal text-muted-foreground">
                {keys.length} connection{keys.length !== 1 ? "s" : ""}{" "}
                configured
              </span>
            )}
          </span>
        }
        description={description}
        onClick={() => {
          if (!isFormOpen) {
            track("ai_provider_connect_clicked", {
              provider_id: "openai-compatible",
              preset_id: preset?.id ?? null,
              method: "api-key",
            });
            setIsFormOpen(true);
          }
        }}
        action={
          isActive ? (
            <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
          ) : undefined
        }
      >
        {isActive && (
          <KeyList keys={keys} onDelete={deleteKey} isDeleting={isDeleting} />
        )}
      </SettingsCardItem>

      <Dialog
        open={isFormOpen}
        onOpenChange={(open) => {
          if (!open) setIsFormOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {displayName}</DialogTitle>
            <DialogDescription>
              {preset
                ? `Add a ${preset.name} connection. Multiple connections of the same kind are supported.`
                : "Enter the base URL and optional API key for any OpenAI-compatible endpoint."}
            </DialogDescription>
          </DialogHeader>
          <ConnectOpenAICompatibleForm
            preset={preset ?? undefined}
            onCancel={() => setIsFormOpen(false)}
            onSuccess={() => setIsFormOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ProviderCardGrid({
  hideProviderId,
}: {
  hideProviderId?: string;
} = {}) {
  const aiProviders = useAiProviders();
  const allKeys = useAiProviderKeys();
  const providers: AiProvider[] = (aiProviders?.providers ?? []).filter(
    (p) => p.id !== hideProviderId,
  );
  const localProviders = providers.filter((p) =>
    p.supportedMethods.includes("cli-activate"),
  );
  const cloudProviders = providers.filter(
    (p) =>
      !p.supportedMethods.includes("cli-activate") &&
      p.id !== "openai-compatible",
  );

  // Keys for the openai-compatible provider, split per preset id (null = Custom).
  const openaiCompatibleKeys = allKeys.filter(
    (k) => k.providerId === "openai-compatible",
  );
  const showOpenAICompatibleSection = hideProviderId !== "openai-compatible";
  const openaiCompatibleProvider = (aiProviders?.providers ?? []).find(
    (p) => p.id === "openai-compatible",
  );

  return (
    <div className="flex flex-col gap-6 w-full">
      {localProviders.length > 0 && (
        <SettingsSection>
          <div className="relative rounded-xl border border-lime-400/30 bg-gradient-to-br from-lime-50/50 via-transparent to-yellow-50/30 dark:from-lime-950/20 dark:to-yellow-950/10 p-4">
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-lime-400/5 to-yellow-400/5 pointer-events-none" />
            <p className="text-xs font-medium text-lime-700 dark:text-lime-400 mb-3 relative">
              Local models — use your existing AI provider
            </p>
            <SettingsCard className="relative">
              {localProviders.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  keys={allKeys.filter((k) => k.providerId === provider.id)}
                />
              ))}
            </SettingsCard>
          </div>
        </SettingsSection>
      )}
      <SettingsSection>
        <SettingsCard>
          {[
            ...cloudProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                keys={allKeys.filter((k) => k.providerId === provider.id)}
              />
            )),
            ...(showOpenAICompatibleSection
              ? [
                  ...OPENAI_COMPATIBLE_PRESETS.map((preset) => (
                    <OpenAICompatiblePresetCard
                      key={preset.id}
                      preset={preset}
                      keys={openaiCompatibleKeys.filter(
                        (k) => k.presetId === preset.id,
                      )}
                    />
                  )),
                  <OpenAICompatiblePresetCard
                    key="custom"
                    preset={null}
                    keys={openaiCompatibleKeys.filter((k) => !k.presetId)}
                    fallbackLogo={openaiCompatibleProvider?.logo}
                  />,
                ]
              : []),
          ]}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

// ── Page assembly ────────────────────────────────────────────────────

function OrgAiProvidersContent() {
  const allKeys = useAiProviderKeys();
  const hasDecoKey = allKeys.some((k) => k.providerId === "deco");

  return (
    <>
      <Suspense fallback={<Skeleton className="h-16 w-full" />}>
        <SimpleModeSection />
      </Suspense>
      <DecoCreditsHero />
      <ProviderCardGrid hideProviderId={hasDecoKey ? "deco" : undefined} />
    </>
  );
}

export function OrgAiProvidersPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>AI Providers</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load AI providers")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <OrgAiProvidersContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
