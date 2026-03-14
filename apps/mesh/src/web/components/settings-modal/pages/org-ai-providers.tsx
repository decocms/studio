import { Suspense, useState, useEffect } from "react";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  Trash01,
  Key01,
  Eye,
  EyeOff,
  AlertCircle,
  CreditCard01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  useAiProviders,
  useAiProviderKeyList,
  type AiProviderKey,
} from "@/web/hooks/collections/use-llm";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { cn } from "@deco/ui/lib/utils.ts";
import { ErrorBoundary } from "../../error-boundary";

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
  return (
    <div className="flex flex-col gap-2 mt-4">
      {keys.map((key) => (
        <div
          key={key.id}
          className="flex items-center justify-between p-2 rounded-md bg-muted/50 text-sm"
        >
          <div className="flex items-center gap-2 overflow-hidden">
            <Key01 size={14} className="text-muted-foreground shrink-0" />
            <span className="font-medium truncate">{key.label}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              added {formatDistanceToNow(new Date(key.createdAt))} ago
            </span>
          </div>
          {/* Stop propagation so trash click doesn't trigger card's onClick */}
          <div onClick={(e) => e.stopPropagation()}>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  disabled={isDeleting}
                >
                  <Trash01 size={14} />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-2" align="end">
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium">Delete this key?</p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => onDelete(key.id)}
                      disabled={isDeleting}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConnectApiKeyForm({
  providerId,
  onCancel,
  onSuccess,
}: {
  providerId: string;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const {
    mutate: createKey,
    isPending,
    error,
  } = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_CREATE",
        arguments: {
          providerId,
          label: label || "Personal key",
          apiKey,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(locator) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(locator) });
      toast.success("Key saved successfully");
      onSuccess();
    },
    onError: (err) => {
      toast.error(`Failed to save key: ${err.message}`);
    },
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Label
        </label>
        <Input
          placeholder="e.g. Personal key"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
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
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="h-8 text-sm pr-8"
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

      {error && <p className="text-xs text-destructive">{error.message}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => createKey()}
          disabled={!apiKey || isPending}
        >
          {isPending ? "Saving..." : "Save Key"}
        </Button>
      </div>
    </div>
  );
}

export type AiProvider = {
  id: string;
  name: string;
  description: string;
  logo?: string | null;
  connectionMethod?: "api-key" | "oauth-pkce";
  supportedMethods: ("api-key" | "oauth-pkce")[];
  supportsTopUp?: boolean;
  supportsCredits?: boolean;
};

function TopUpForm({
  keyId,
  providerId,
  onCancel,
}: {
  keyId: string;
  providerId: string;
  onCancel: () => void;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const [amount, setAmount] = useState("10");
  const [currency, setCurrency] = useState<"usd" | "brl">("usd");

  const { mutate: topUp, isPending } = useMutation({
    mutationFn: async () => {
      const amountCents = Math.round(parseFloat(amount) * 100);
      const result = (await client.callTool({
        name: "AI_PROVIDER_TOPUP_URL",
        arguments: { providerId, keyId, amountCents, currency },
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
      onCancel();
    },
    onError: (err) => {
      toast.error(`Top-up failed: ${err.message}`);
    },
  });

  const amountNum = parseFloat(amount);
  const isValid = !isNaN(amountNum) && amountNum >= 1;
  const currencySymbol = currency === "brl" ? "R$" : "$";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground select-none">
            {currencySymbol}
          </span>
          <Input
            type="number"
            min="1"
            step="1"
            placeholder="10"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-8 text-sm pl-8"
          />
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          value={currency}
          onValueChange={(v) => {
            if (v) setCurrency(v as "usd" | "brl");
          }}
        >
          <ToggleGroupItem value="usd" className="h-8 px-2 text-xs">
            USD
          </ToggleGroupItem>
          <ToggleGroupItem value="brl" className="h-8 px-2 text-xs">
            BRL
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => topUp()}
          disabled={!isValid || isPending}
        >
          {isPending ? "Opening..." : "Checkout"}
        </Button>
      </div>
    </div>
  );
}

function CreditsBalance({ providerId }: { providerId: string }) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: KEYS.aiProviderCredits(locator, providerId),
    staleTime: 60_000,
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_CREDITS",
        arguments: { providerId },
      })) as {
        structuredContent?: { balanceCents: number };
        isError?: boolean;
        content?: { text?: string }[];
      };
      if (result?.isError) {
        throw new Error(result.content?.[0]?.text ?? "Failed to fetch credits");
      }
      return result.structuredContent ?? null;
    },
  });

  const dollars = data != null ? (data.balanceCents / 100).toFixed(2) : null;

  return (
    <div
      className="flex items-center gap-1.5 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-muted-foreground">Balance:</span>
      {isLoading || isFetching ? (
        <Skeleton className="h-3 w-12 inline-block" />
      ) : dollars != null ? (
        <span className="font-medium tabular-nums">${dollars}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
      <button
        type="button"
        onClick={() => refetch()}
        disabled={isFetching}
        className="text-muted-foreground hover:text-foreground disabled:opacity-50 ml-0.5"
        title="Refresh balance"
      >
        ↻
      </button>
    </div>
  );
}

export function ProviderCard({
  provider,
  keys,
}: {
  provider: AiProvider;
  keys: AiProviderKey[];
}) {
  const { locator, org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();
  const [isConnectFormOpen, setIsConnectFormOpen] = useState(false);
  const [isOAuthPending, setIsOAuthPending] = useState(false);
  const [oauthStateToken, setOauthStateToken] = useState<string | null>(null);
  const [topUpKeyId, setTopUpKeyId] = useState<string | null>(null);

  const isActive = keys.length > 0;
  const isClaudeCode = provider.id === "claude-code";

  const { mutate: deleteKey, isPending: isDeleting } = useMutation({
    mutationFn: async (keyId: string) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId },
      });
      return keyId; // Return keyId for invalidation logic if needed
    },
    onSuccess: (deletedKeyId) => {
      if (topUpKeyId === deletedKeyId) setTopUpKeyId(null);
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(locator) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(locator) });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderModels(locator, deletedKeyId),
      });
      if (isClaudeCode && keys.length === 1) {
        fetch(`/api/${org.slug}/decopilot/connect-studio`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "claude-code" }),
        })
          .then(() => {
            queryClient.invalidateQueries({
              queryKey: KEYS.connectStudioStatus(org.slug),
            });
          })
          .catch(() => {
            toast.error("Failed to remove MCP from Claude Code");
          });
      }
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
          label: "Connected via OAuth",
        },
      })) as { isError?: boolean; content?: { text?: string }[] };
      if (result?.isError) {
        const msg = result.content?.[0]?.text ?? "OAuth exchange failed";
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(locator) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(locator) });
      toast.success(`${provider.name} connected successfully`);
      setIsOAuthPending(false);
      setOauthStateToken(null);
    },
    onError: (err) => {
      toast.error(`OAuth connection failed: ${err.message}`);
      setIsOAuthPending(false);
      setOauthStateToken(null);
    },
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (!isOAuthPending || !oauthStateToken) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "AI_PROVIDER_OAUTH_CALLBACK") {
        const { code, stateToken } = event.data;
        if (stateToken === oauthStateToken) {
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

    // Timeout after 2 minutes
    const timeoutId = setTimeout(() => {
      if (isOAuthPending) {
        setIsOAuthPending(false);
        setOauthStateToken(null);
        toast.error("Connection timed out");
      }
    }, 120000);

    return () => {
      window.removeEventListener("message", handleMessage);
      clearTimeout(timeoutId);
    };
  }, [isOAuthPending, oauthStateToken, exchangeOAuth]);

  const supportsOAuth = provider.supportedMethods.includes("oauth-pkce");
  const supportsApiKey = provider.supportedMethods.includes("api-key");
  const [isClaudeCodePending, setIsClaudeCodePending] = useState(false);

  const connectStudioStatus = useQuery({
    queryKey: KEYS.connectStudioStatus(org.slug),
    queryFn: async () => {
      const res = await fetch(
        `/api/${org.slug}/decopilot/connect-studio/status`,
      );
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json() as Promise<{
        claude: {
          connected: boolean;
          auth: Record<string, string | undefined> | null;
        };
      }>;
    },
    enabled: isClaudeCode && isActive,
  });

  const handleConnectClaudeCode = async () => {
    if (isActive || isClaudeCodePending) return;
    setIsClaudeCodePending(true);
    try {
      await client.callTool({
        name: "AI_PROVIDER_KEY_CREATE",
        arguments: {
          providerId: "claude-code",
          label: "Local CLI",
          apiKey: "local",
        },
      });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderKeys(locator),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(locator) });

      // Also register MCP in Claude Code CLI
      try {
        const res = await fetch(`/api/${org.slug}/decopilot/connect-studio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "claude-code" }),
        });
        if (!res.ok) throw new Error("MCP registration failed");
        queryClient.invalidateQueries({
          queryKey: KEYS.connectStudioStatus(org.slug),
        });
        toast.success("Claude Code connected!");
      } catch {
        toast.error(
          "Connected as provider but failed to register MCP in Claude Code",
        );
      }
    } catch (err) {
      toast.error(
        `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsClaudeCodePending(false);
    }
  };

  const handleCardClick = () => {
    if (isConnectFormOpen || isOAuthPending) return;
    if (isClaudeCode) {
      handleConnectClaudeCode();
    } else if (supportsOAuth) {
      handleConnectOAuth();
    } else if (supportsApiKey) {
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

  return (
    <Popover
      open={isConnectFormOpen}
      onOpenChange={(open) => {
        if (!open) setIsConnectFormOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <Card
          className={cn(
            "p-4 flex flex-col gap-3 transition-colors relative",
            isActive && "border-primary/20",
            !isOAuthPending &&
              !isClaudeCodePending &&
              "cursor-pointer hover:bg-muted/30",
            (isOAuthPending || isClaudeCodePending) && "cursor-wait",
          )}
          onClick={handleCardClick}
        >
          {isActive && (
            <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-green-500" />
          )}

          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              {provider.logo ? (
                <img
                  src={provider.logo}
                  alt={provider.name}
                  className="size-8 rounded-md object-contain"
                />
              ) : (
                <Avatar
                  fallback={provider.name.charAt(0)}
                  className="size-8 bg-primary/10 text-primary"
                />
              )}
              <div>
                <h3 className="font-medium text-base">{provider.name}</h3>
                <p className="text-sm text-muted-foreground line-clamp-1">
                  {isClaudeCodePending
                    ? "Connecting..."
                    : isOAuthPending
                      ? "Authorizing..."
                      : provider.description}
                </p>
              </div>
            </div>
          </div>

          {isActive && (
            <div className="mt-1">
              {provider.supportsCredits && (
                <div className="mb-2">
                  <CreditsBalance providerId={provider.id} />
                </div>
              )}
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  {keys.length} key{keys.length !== 1 ? "s" : ""} configured
                </p>
                {provider.supportsTopUp && (
                  <div onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-6 gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setTopUpKeyId(topUpKeyId ? null : (keys[0]?.id ?? null))
                      }
                    >
                      <CreditCard01 size={12} />
                      Add credits
                    </Button>
                  </div>
                )}
              </div>
              {topUpKeyId && keys.some((k) => k.id === topUpKeyId) && (
                <div
                  className="mt-2 p-3 rounded-md border bg-muted/30"
                  onClick={(e) => e.stopPropagation()}
                >
                  <TopUpForm
                    keyId={topUpKeyId}
                    providerId={provider.id}
                    onCancel={() => setTopUpKeyId(null)}
                  />
                </div>
              )}
              {isClaudeCode && connectStudioStatus.data?.claude?.auth && (
                <p className="text-xs text-muted-foreground truncate">
                  {Object.values(connectStudioStatus.data.claude.auth)
                    .filter(Boolean)
                    .join(" — ")}
                </p>
              )}
              <KeyList
                keys={keys}
                onDelete={deleteKey}
                isDeleting={isDeleting}
              />
            </div>
          )}
        </Card>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-4"
        align="start"
        onInteractOutside={() => setIsConnectFormOpen(false)}
      >
        <ConnectApiKeyForm
          providerId={provider.id}
          onCancel={() => setIsConnectFormOpen(false)}
          onSuccess={() => setIsConnectFormOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function OrgAiProvidersContent() {
  const aiProviders = useAiProviders();
  const allKeys = useAiProviderKeyList();
  const providers = aiProviders?.providers ?? [];
  const isEven = providers.length % 2 === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">AI Providers</h2>
        <p className="text-sm text-muted-foreground">
          Set up AI model providers. Keys are stored encrypted in the vault.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 [&>*:first-child]:lg:col-span-2">
        {providers.map((provider, index) => (
          <div
            key={provider.id}
            className={cn(
              isEven && index === providers.length - 1 && "lg:col-span-2",
            )}
          >
            <ProviderCard
              provider={provider}
              keys={allKeys.filter((k) => k.providerId === provider.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function OrgAiProvidersPage() {
  return (
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
  );
}
