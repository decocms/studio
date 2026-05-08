import { Suspense, useState, useEffect } from "react";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  Trash01,
  Key01,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle,
  RefreshCw01,
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
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
  useAiProviderModels,
  type AiProviderKey,
  type AiProviderModel,
} from "@/web/hooks/collections/use-ai-providers";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  pickSimpleModeDefaults,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { track } from "@/web/lib/posthog-client";
import { cn } from "@deco/ui/lib/utils.ts";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  useSimpleMode,
  useUpdateSimpleMode,
  type SimpleModeConfig,
} from "@/web/hooks/use-organization-settings";
import { SimpleModeConfigSchema } from "@/tools/organization/schema";
import { ModelSelector } from "@/web/components/chat/select-model";
import {
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
} from "@/web/utils/openai-compatible-presets";

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

const apiKeyFormSchema = z.object({
  label: z.string().optional(),
  apiKey: z.string().min(1, "API key is required"),
});

type ApiKeyFormData = z.infer<typeof apiKeyFormSchema>;

function ConnectApiKeyForm({
  providerId,
  onCancel,
  onSuccess,
}: {
  providerId: string;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ApiKeyFormData>({
    resolver: zodResolver(apiKeyFormSchema),
    defaultValues: { label: "", apiKey: "" },
  });

  const {
    mutate: createKey,
    isPending,
    error,
  } = useMutation({
    mutationFn: async (data: ApiKeyFormData) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_CREATE",
        arguments: {
          providerId,
          label: data.label || "Personal key",
          apiKey: data.apiKey,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success("Key saved successfully");
      onSuccess();
    },
    onError: (err) => {
      toast.error(`Failed to save key: ${err.message}`);
    },
  });

  return (
    <form
      onSubmit={handleSubmit((data) => createKey(data))}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Label
        </label>
        <Input
          placeholder="e.g. Personal key"
          {...register("label")}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          API Key
        </label>
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            placeholder="sk-..."
            {...register("apiKey")}
            className="ph-no-capture h-8 text-sm pr-8"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {errors.apiKey && (
          <p className="text-xs text-destructive">{errors.apiKey.message}</p>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error.message}</p>}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving..." : "Save Key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

const openaiCompatibleFormSchema = z.object({
  label: z.string().optional(),
  baseUrl: z.string().min(1, "Base URL is required"),
  apiKey: z.string().optional(),
});

type OpenAICompatibleFormData = z.infer<typeof openaiCompatibleFormSchema>;

function ConnectOpenAICompatibleForm({
  preset,
  onCancel,
  onSuccess,
}: {
  preset?: OpenAICompatiblePreset;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<OpenAICompatibleFormData>({
    resolver: zodResolver(openaiCompatibleFormSchema),
    defaultValues: { label: "", baseUrl: "", apiKey: "" },
  });

  const {
    mutate: createKey,
    isPending,
    error,
  } = useMutation({
    mutationFn: async (data: OpenAICompatibleFormData) => {
      const encodedKey = JSON.stringify({
        baseUrl: data.baseUrl,
        apiKey: data.apiKey || "",
      });
      await client.callTool({
        name: "AI_PROVIDER_KEY_CREATE",
        arguments: {
          providerId: "openai-compatible",
          label: data.label || preset?.name || data.baseUrl,
          apiKey: encodedKey,
          ...(preset ? { presetId: preset.id } : {}),
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success("Connection saved successfully");
      onSuccess();
    },
    onError: (err) => {
      toast.error(`Failed to save connection: ${err.message}`);
    },
  });

  const labelPlaceholder = preset
    ? `e.g. ${preset.name} prod, ${preset.name} dev`
    : "e.g. My OpenAI-compatible server";
  const baseUrlPlaceholder =
    preset?.baseUrlPlaceholder ?? "http://localhost:4000/v1";

  return (
    <form
      onSubmit={handleSubmit((data) => createKey(data))}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Label
        </label>
        <Input
          placeholder={labelPlaceholder}
          {...register("label")}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Base URL
        </label>
        <Input
          type="url"
          placeholder={baseUrlPlaceholder}
          {...register("baseUrl")}
          className="h-8 text-sm"
        />
        {errors.baseUrl && (
          <p className="text-xs text-destructive">{errors.baseUrl.message}</p>
        )}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          API Key{" "}
          <span className="text-muted-foreground/60">
            ({preset?.apiKeyRecommended ? "recommended" : "optional"})
          </span>
        </label>
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            placeholder="sk-..."
            {...register("apiKey")}
            className="ph-no-capture h-8 text-sm pr-8"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {preset?.helpText && (
        <p className="text-xs text-muted-foreground">{preset.helpText}</p>
      )}

      {error && <p className="text-xs text-destructive">{error.message}</p>}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving..." : "Save Connection"}
        </Button>
      </DialogFooter>
    </form>
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

// ── Quick Top-Up presets ──────────────────────────────────────────────

const TOP_UP_PRESETS = {
  usd: [10, 20, 100],
  brl: [50, 100, 500],
} as const;

function QuickTopUp() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [customOpen, setCustomOpen] = useState(false);

  const { mutate: topUp, isPending } = useMutation({
    mutationFn: async (amountCents: number) => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_TOPUP_URL",
        arguments: {
          providerId: "deco",
          amountCents,
          currency,
        },
      })) as {
        structuredContent?: { url: string };
        isError?: boolean;
        content?: { text?: string }[];
      };
      if (result?.isError) {
        throw new Error(
          result.content?.[0]?.text ?? "Failed to get top-up URL",
        );
      }
      return result.structuredContent?.url;
    },
    onSuccess: (url) => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    onError: (err) => {
      toast.error(`Top-up failed: ${err.message}`);
    },
  });

  const [customAmount, setCustomAmount] = useState("");
  const [currency, setCurrency] = useState<"usd" | "brl">("usd");
  const customNum = parseFloat(customAmount);
  const isCustomValid = !isNaN(customNum) && customNum >= 1;
  const currencySymbol = currency === "brl" ? "R$" : "$";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="default"
          value={currency}
          onValueChange={(v) => {
            if (v) setCurrency(v as "usd" | "brl");
          }}
        >
          <ToggleGroupItem value="usd" className="px-3.5 text-sm">
            USD
          </ToggleGroupItem>
          <ToggleGroupItem value="brl" className="px-3.5 text-sm">
            BRL
          </ToggleGroupItem>
        </ToggleGroup>
        {!customOpen && (
          <>
            {TOP_UP_PRESETS[currency].map((dollars) => (
              <Button
                key={dollars}
                variant="outline"
                className="h-10 px-4 text-sm font-medium tabular-nums"
                disabled={isPending}
                onClick={() => topUp(dollars * 100)}
              >
                {currencySymbol}
                {dollars}
              </Button>
            ))}
            <Button
              variant="ghost"
              className="h-10 px-4 text-sm text-muted-foreground"
              onClick={() => setCustomOpen(true)}
              disabled={isPending}
            >
              Custom
            </Button>
          </>
        )}
        {customOpen && (
          <>
            <div className="relative max-w-[140px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground select-none">
                {currencySymbol}
              </span>
              <Input
                type="number"
                min="1"
                step="1"
                placeholder="50"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                className="h-10 text-sm pl-7"
                autoFocus
              />
            </div>
            <Button
              className="h-10"
              disabled={!isCustomValid || isPending}
              onClick={() => topUp(Math.round(customNum * 100))}
            >
              {isPending ? "..." : "Add"}
            </Button>
            <Button
              variant="ghost"
              className="h-10 text-sm text-muted-foreground"
              onClick={() => {
                setCustomOpen(false);
                setCustomAmount("");
              }}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Deco Credits Hero ────────────────────────────────────────────────

function creditColorClass(dollars: number): string {
  if (dollars <= 0) return "text-destructive";
  if (dollars <= 1) return "text-amber-500 dark:text-amber-400";
  return "text-foreground";
}

function DecoCreditsHero() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const allKeys = useAiProviderKeys();
  const decoKey = allKeys.find((k) => k.providerId === "deco");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const { mutate: disconnect, isPending: isDisconnecting } = useMutation({
    mutationFn: async () => {
      if (!decoKey) return;
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId: decoKey.id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success("Deco AI Gateway disconnected");
      setConfirmDisconnect(false);
    },
    onError: (err) => {
      toast.error(`Failed to disconnect: ${err.message}`);
    },
  });

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: KEYS.aiProviderCredits(org.id, "deco"),
    enabled: !!decoKey,
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_CREDITS",
        arguments: { providerId: "deco" },
      })) as {
        structuredContent?: { balanceCents: number };
        isError?: boolean;
      };
      if (result?.isError) return null;
      return result.structuredContent ?? null;
    },
  });

  if (!decoKey) return null;

  const balanceDollars =
    data?.balanceCents != null ? data.balanceCents / 100 : null;
  const displayBalance =
    balanceDollars != null ? `$${balanceDollars.toFixed(2)}` : "—";

  return (
    <SettingsSection title="Deco AI Gateway">
      <SettingsCard>
        <div className="px-5 py-5 flex flex-col gap-5">
          {/* Provider info and disconnect button */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src="/logos/deco%20logo.svg"
                alt="Deco AI Gateway"
                className="size-9 rounded-lg object-contain dark:bg-white dark:p-0.5"
              />
              <div>
                <p className="text-xs text-muted-foreground">
                  Access to 100+ models
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDisconnect(true)}
              disabled={isDisconnecting}
            >
              Disconnect
            </Button>
          </div>

          <AlertDialog
            open={confirmDisconnect}
            onOpenChange={setConfirmDisconnect}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Deco AI Gateway</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the Deco AI Gateway from this workspace. Your
                  credit balance is preserved and will be available if you
                  reconnect.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => disconnect()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Balance */}
          <div className="flex flex-col gap-2 pt-2">
            <div className="flex items-baseline gap-2">
              {isLoading || isFetching ? (
                <Skeleton className="h-9 w-24" />
              ) : (
                <span
                  className={cn(
                    "text-3xl font-semibold tabular-nums tracking-tight",
                    balanceDollars != null && creditColorClass(balanceDollars),
                  )}
                >
                  {displayBalance}
                </span>
              )}
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isFetching}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors p-1 rounded-md hover:bg-muted/50"
                aria-label="Refresh balance"
              >
                <RefreshCw01
                  size={14}
                  className={cn(isFetching && "animate-spin")}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Available credit balance
            </p>
          </div>

          {/* Quick top-up */}
          <div className="pt-4 border-t border-border/60">
            <p className="text-xs font-medium text-muted-foreground mb-2.5">
              Add credits
            </p>
            <QuickTopUp />
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

// ── Simple Model Mode ────────────────────────────────────────────────

const filterImageModels = (m: AiProviderModel) =>
  m.capabilities?.includes("image") === true;

const filterWebResearchModels = (m: AiProviderModel) => {
  if (m.asyncResearch === true) return true;
  const n = m.modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.includes("sonar") || n.includes("deepresearch");
};

type TierKey = "fast" | "smart" | "thinking";

const TIER_LABELS: Record<TierKey, string> = {
  fast: "Fast",
  smart: "Smart",
  thinking: "Thinking",
};

const TIER_DESCRIPTIONS: Record<TierKey, string> = {
  fast: "Fastest responses, best for quick tasks",
  smart: "Balanced speed and capability",
  thinking: "Most capable, best for complex tasks",
};

function SimpleModeModelRow({
  slot,
  onSlotChange,
  filterModels,
  defaultKeyId,
}: {
  slot: SimpleModeConfig["chat"]["fast"];
  onSlotChange: (slot: SimpleModeConfig["chat"]["fast"]) => void;
  filterModels?: (m: AiProviderModel) => boolean;
  defaultKeyId: string | null;
}) {
  const allKeys = useAiProviderKeys();
  const [localCredentialId, setLocalCredentialId] = useState<string | null>(
    slot?.keyId ?? defaultKeyId,
  );

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (slot?.keyId) setLocalCredentialId(slot.keyId);
  }, [slot?.keyId]);

  const activeKeyId = localCredentialId ?? defaultKeyId;
  const slotKey = activeKeyId
    ? allKeys.find((k) => k.id === activeKeyId)
    : null;

  const { models: activeModels, isLoading: isLoadingModels } =
    useAiProviderModels(filterModels ? (activeKeyId ?? undefined) : undefined);
  const hasFilteredModels = filterModels
    ? isLoadingModels || activeModels.some(filterModels)
    : true;

  const resolvedModel: AiProviderModel | null = slot
    ? ({
        modelId: slot.modelId,
        title: slot.title ?? slot.modelId,
        keyId: slot.keyId,
        providerId: slotKey?.providerId ?? "deco",
        description: null,
        logo: null,
        capabilities: [],
        limits: null,
        costs: null,
      } as AiProviderModel)
    : null;

  if (filterModels && !hasFilteredModels) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Not available with current provider
      </p>
    );
  }

  return (
    <ModelSelector
      variant="bordered"
      placeholder="Pick model"
      model={resolvedModel}
      credentialId={activeKeyId}
      filterModels={filterModels}
      onCredentialChange={(keyId) => setLocalCredentialId(keyId)}
      onModelChange={(m) => {
        const keyId = m.keyId ?? activeKeyId ?? "";
        setLocalCredentialId(keyId);
        onSlotChange({ keyId, modelId: m.modelId, title: m.title });
      }}
    />
  );
}

function AutosaveStatus({
  isPending,
  showSaved,
}: {
  isPending: boolean;
  showSaved: boolean;
}) {
  if (isPending) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <RefreshCw01 size={12} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (showSaved) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <CheckCircle size={12} />
        Saved
      </span>
    );
  }
  return null;
}

function SimpleModeSection() {
  const allKeys = useAiProviderKeys();
  const simpleMode = useSimpleMode();
  const hasProvider = allKeys.length > 0;

  const form = useForm<SimpleModeConfig>({
    resolver: zodResolver(SimpleModeConfigSchema),
    values: simpleMode,
    mode: "onChange",
  });

  const {
    mutate: updateSimpleMode,
    isPending,
    isSuccess,
  } = useUpdateSimpleMode();

  const isDirty = form.formState.isDirty;

  // Autosave: 250ms after the last `schedule()` call, persist. The debounce
  // coalesces multi-field writes from handleToggle and Effect 2 into a
  // single mutation. We can't gate on `formState.isDirty` here: handleToggle
  // calls `form.reset(...)` to seed defaults (which rebases the dirty
  // baseline) and the `values: simpleMode` prop resyncs the form on every
  // cache update — both clear the flag before the timer fires, swallowing
  // the save. Each `schedule()` call is the explicit save intent; nothing
  // inside `save` re-schedules so there's no feedback loop.
  const { schedule: scheduleAutosave } = useDebouncedAutosave({
    delayMs: 250,
    save: async () => {
      const values = form.getValues();
      updateSimpleMode(values, {
        onSuccess: () => form.reset(values, { keepValues: true }),
        onError: (err) => {
          form.reset(simpleMode);
          toast.error(`Failed to save: ${err.message}`);
        },
      });
    },
  });

  // Lazily load models for the first 3 keys so we can pre-fill defaults.
  // Hooks can't run in loops; capping at 3 is sufficient for defaults —
  // the user can always pick manually.
  const key0 = allKeys[0];
  const key1 = allKeys[1];
  const key2 = allKeys[2];
  const { models: models0 } = useAiProviderModels(key0?.id);
  const { models: models1 } = useAiProviderModels(key1?.id);
  const { models: models2 } = useAiProviderModels(key2?.id);

  const handleToggle = (enabled: boolean) => {
    const currentChat = form.getValues("chat");
    if (
      enabled &&
      !currentChat.fast &&
      !currentChat.smart &&
      !currentChat.thinking
    ) {
      const modelsByKeyId: Record<string, AiProviderModel[]> = {};
      if (key0?.id) modelsByKeyId[key0.id] = models0;
      if (key1?.id) modelsByKeyId[key1.id] = models1;
      if (key2?.id) modelsByKeyId[key2.id] = models2;
      const defaults = pickSimpleModeDefaults(allKeys, modelsByKeyId);
      form.reset(
        {
          enabled: true,
          chat: defaults.chat,
          image: defaults.image,
          webResearch: defaults.webResearch,
        },
        { keepDirty: true },
      );
    } else {
      form.setValue("enabled", enabled, { shouldDirty: true });
    }
    scheduleAutosave();
  };

  // Effect 1: Clear form when all providers are removed.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — reacts to async provider list changes
  useEffect(() => {
    if (!hasProvider) {
      form.reset({
        enabled: false,
        chat: { fast: null, smart: null, thinking: null },
        image: null,
        webResearch: null,
      });
    }
  }, [hasProvider, form]);

  // Effect 2: Fill null slots with defaults once models finish loading,
  // and clear slots whose keyId no longer exists in allKeys (stale provider).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — reacts to async model list loading
  useEffect(() => {
    const current = form.getValues();
    if (!current.enabled) return;

    const validKeyIds = new Set(allKeys.map((k) => k.id));
    const modelsByKeyId: Record<string, AiProviderModel[]> = {};
    if (key0?.id) modelsByKeyId[key0.id] = models0;
    if (key1?.id) modelsByKeyId[key1.id] = models1;
    if (key2?.id) modelsByKeyId[key2.id] = models2;

    const isStale = (slot: SimpleModeConfig["chat"]["fast"]) =>
      slot != null && !validKeyIds.has(slot.keyId);

    const clearedChat = {
      fast: isStale(current.chat.fast) ? null : current.chat.fast,
      smart: isStale(current.chat.smart) ? null : current.chat.smart,
      thinking: isStale(current.chat.thinking) ? null : current.chat.thinking,
    };
    const clearedImage = isStale(current.image) ? null : current.image;
    const clearedWebResearch = isStale(current.webResearch)
      ? null
      : current.webResearch;

    const needsFill =
      !clearedChat.fast ||
      !clearedChat.smart ||
      !clearedChat.thinking ||
      !clearedImage ||
      !clearedWebResearch;

    const chatUnchanged =
      clearedChat.fast === current.chat.fast &&
      clearedChat.smart === current.chat.smart &&
      clearedChat.thinking === current.chat.thinking;
    if (!needsFill && chatUnchanged) return;

    const defaults = pickSimpleModeDefaults(allKeys, modelsByKeyId);
    form.reset(
      {
        ...current,
        chat: {
          fast: clearedChat.fast ?? defaults.chat.fast,
          smart: clearedChat.smart ?? defaults.chat.smart,
          thinking: clearedChat.thinking ?? defaults.chat.thinking,
        },
        image: clearedImage ?? defaults.image,
        webResearch: clearedWebResearch ?? defaults.webResearch,
      },
      { keepDirty: true },
    );
  }, [form, allKeys, models0, models1, models2, key0?.id, key1?.id, key2?.id]);

  const enabled = form.watch("enabled");
  const effectiveEnabled = enabled && hasProvider;

  return (
    <SettingsSection title="Simple model mode">
      <SettingsCard>
        <SettingsCardItem
          title="Enable simple model mode"
          description={
            hasProvider
              ? "Replace the model picker with a Fast / Smart / Thinking toggle for all members of this org."
              : "Connect an AI provider above to enable this feature."
          }
          action={
            <div className="flex items-center gap-3">
              <AutosaveStatus
                isPending={isPending}
                showSaved={isSuccess && !isDirty}
              />
              <Switch
                checked={effectiveEnabled}
                onCheckedChange={handleToggle}
                disabled={isPending || !hasProvider}
              />
            </div>
          }
        />
        {effectiveEnabled && (
          <>
            {(["fast", "smart", "thinking"] as TierKey[]).map((tier) => (
              <Controller
                key={tier}
                control={form.control}
                name={`chat.${tier}` as const}
                render={({ field }) => (
                  <SettingsCardItem
                    title={TIER_LABELS[tier]}
                    description={TIER_DESCRIPTIONS[tier]}
                    action={
                      <SimpleModeModelRow
                        slot={field.value}
                        defaultKeyId={allKeys[0]?.id ?? null}
                        onSlotChange={(slot) => {
                          field.onChange(slot);
                          scheduleAutosave();
                        }}
                      />
                    }
                  />
                )}
              />
            ))}
            <div className="h-px bg-border mx-5" />
            <Controller
              control={form.control}
              name="image"
              render={({ field }) => (
                <SettingsCardItem
                  title="Image"
                  action={
                    <SimpleModeModelRow
                      slot={field.value}
                      defaultKeyId={allKeys[0]?.id ?? null}
                      filterModels={filterImageModels}
                      onSlotChange={(slot) => {
                        field.onChange(slot);
                        scheduleAutosave();
                      }}
                    />
                  }
                />
              )}
            />
            <Controller
              control={form.control}
              name="webResearch"
              render={({ field }) => (
                <SettingsCardItem
                  title="Web research"
                  action={
                    <SimpleModeModelRow
                      slot={field.value}
                      defaultKeyId={allKeys[0]?.id ?? null}
                      filterModels={filterWebResearchModels}
                      onSlotChange={(slot) => {
                        field.onChange(slot);
                        scheduleAutosave();
                      }}
                    />
                  }
                />
              )}
            />
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

// ── Page assembly ────────────────────────────────────────────────────

function OrgAiProvidersContent() {
  const allKeys = useAiProviderKeys();
  const hasDecoKey = allKeys.some((k) => k.providerId === "deco");

  return (
    <>
      {allKeys.length > 0 && (
        <Suspense fallback={<Skeleton className="h-16 w-full" />}>
          <SimpleModeSection />
        </Suspense>
      )}
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
