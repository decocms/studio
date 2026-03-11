import { Suspense, useState, useEffect } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  Trash01,
  Plus,
  Key01,
  Eye,
  EyeOff,
  AlertCircle,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
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
    <div className="mt-4 p-4 border rounded-md bg-muted/30 space-y-3">
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
  logo: string | null;
  connectionMethod: "api-key" | "oauth-pkce";
  supportedMethods: ("api-key" | "oauth-pkce")[];
};

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

  const isActive = keys.length > 0;

  const { mutate: deleteKey, isPending: isDeleting } = useMutation({
    mutationFn: async (keyId: string) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId },
      });
      return keyId; // Return keyId for invalidation logic if needed
    },
    onSuccess: (deletedKeyId) => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(locator) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(locator) });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderModels(locator, deletedKeyId),
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
          console.error("State token mismatch", {
            expected: oauthStateToken,
            received: stateToken,
          });
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
    <Card
      className={cn(
        "p-4 flex flex-col gap-3",
        isActive && "border-primary/20 relative",
      )}
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
              {provider.description}
            </p>
          </div>
        </div>
      </div>

      {isActive ? (
        <div className="mt-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              {keys.length} key{keys.length !== 1 ? "s" : ""} configured
            </p>
            <div className="flex items-center gap-1">
              {supportsOAuth && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={handleConnectOAuth}
                  disabled={isOAuthPending || isConnectFormOpen}
                >
                  {provider.logo && (
                    <img src={provider.logo} className="size-3 mr-1" />
                  )}
                  OAuth
                </Button>
              )}
              {supportsApiKey && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setIsConnectFormOpen(true)}
                  disabled={isOAuthPending || isConnectFormOpen}
                >
                  <Plus size={14} className="mr-1" />
                  Add Key
                </Button>
              )}
            </div>
          </div>
          <KeyList keys={keys} onDelete={deleteKey} isDeleting={isDeleting} />
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {supportsOAuth && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleConnectOAuth}
              disabled={isOAuthPending || isConnectFormOpen}
            >
              {isOAuthPending ? (
                "Authorizing..."
              ) : (
                <>
                  {provider.logo && (
                    <img src={provider.logo} className="size-3.5 mr-1.5" />
                  )}
                  OAuth
                </>
              )}
            </Button>
          )}
          {supportsApiKey && (
            <Button
              variant={supportsOAuth ? "ghost" : "outline"}
              size="sm"
              onClick={() => setIsConnectFormOpen(true)}
              disabled={isOAuthPending || isConnectFormOpen}
            >
              <Plus size={13} className="mr-1.5" />
              {supportsOAuth ? "Add manually" : "Add key"}
            </Button>
          )}
        </div>
      )}

      {isConnectFormOpen && (
        <ConnectApiKeyForm
          providerId={provider.id}
          onCancel={() => setIsConnectFormOpen(false)}
          onSuccess={() => setIsConnectFormOpen(false)}
        />
      )}
    </Card>
  );
}

function OrgAiProvidersContent() {
  const aiProviders = useAiProviders();
  const allKeys = useAiProviderKeyList();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium">AI Providers</h2>
        <p className="text-sm text-muted-foreground">
          Set up AI model providers. Keys are stored encrypted in the vault.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {aiProviders?.providers?.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            keys={allKeys.filter((k) => k.providerId === provider.id)}
          />
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
