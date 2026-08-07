import { useEffect, useReducer, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, AlertCircle } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@decocms/ui/components/dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolInput as ToolInput } from "@decocms/shared/tools/tool-io";
import { useAiProviders } from "@/hooks/collections/use-ai-providers";
import { KEYS } from "@/lib/query-keys";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import { getPreset } from "@/utils/openai-compatible-presets";
import { ProviderGrid, type ProviderSelection } from "./provider-grid";
import {
  ConnectApiKeyForm,
  ConnectOpenAICompatibleForm,
} from "./connect-forms";
import {
  initialState,
  reducer,
  type DialogState,
} from "./connect-dialog-state";

interface ConnectProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, skip the provider grid and auto-trigger this selection immediately. */
  initialProvider?: ProviderSelection;
}

function activeProviderId(state: DialogState): string | null {
  switch (state.kind) {
    case "form":
    case "oauth-pending":
    case "provision-pending":
    case "provision-error":
      return state.providerId;
    default:
      return null;
  }
}

export function ConnectProviderDialog({
  open,
  onOpenChange,
  initialProvider,
}: ConnectProviderDialogProps) {
  const t = useT();
  const aiProviders = useAiProviders();
  const providers = aiProviders?.providers ?? [];
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducer, initialState);
  const triggeredRef = useRef(false);

  // Sync the controlled `open` prop with the reducer.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (open && state.kind === "closed") {
      dispatch({ type: "open" });
    } else if (!open && state.kind !== "closed") {
      dispatch({ type: "close" });
    }
  }, [open, state.kind]);

  const close = () => {
    triggeredRef.current = false;
    dispatch({ type: "close" });
    onOpenChange(false);
  };

  const invalidateKeys = () => {
    queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
    queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
  };

  const { mutate: exchangeOAuth } = useMutation({
    mutationFn: async ({
      providerId,
      code,
      stateToken,
      label,
    }: {
      providerId: string;
      code: string;
      stateToken: string;
      label: string;
    }) => {
      await studio.call("AI_PROVIDER_OAUTH_EXCHANGE", {
        providerId:
          providerId as ToolInput<"AI_PROVIDER_OAUTH_EXCHANGE">["providerId"],
        code,
        stateToken,
        label,
      });
      return providerId;
    },
    onSuccess: (providerId) => {
      track("ai_provider_oauth_succeeded", { provider_id: providerId });
      invalidateKeys();
      const provider = providers.find((p) => p.id === providerId);
      toast.success(
        t("settings.connectProviderDialog.oauthSuccessMessage", {
          provider:
            provider?.name ??
            t("settings.connectProviderDialog.defaultProviderName"),
        }),
      );
      close();
    },
    onError: (err, vars) => {
      track("ai_provider_oauth_failed", {
        provider_id: vars.providerId,
        error: err.message,
      });
      toast.error(
        t("settings.connectProviderDialog.oauthFailedMessage", {
          error: err.message,
        }),
      );
      dispatch({ type: "oauth-failed" });
    },
  });

  const { mutate: provisionKey } = useMutation({
    mutationFn: async (providerId: string) => {
      await studio.call("AI_PROVIDER_PROVISION_KEY", {
        providerId:
          providerId as ToolInput<"AI_PROVIDER_PROVISION_KEY">["providerId"],
      });
      return providerId;
    },
    onSuccess: (providerId) => {
      track("ai_provider_provision_succeeded", { provider_id: providerId });
      invalidateKeys();
      const provider = providers.find((p) => p.id === providerId);
      toast.success(
        t("settings.connectProviderDialog.provisionSuccessMessage", {
          provider:
            provider?.name ??
            t("settings.connectProviderDialog.defaultProviderName"),
        }),
      );
      close();
    },
    onError: (err, providerId) => {
      track("ai_provider_provision_failed", {
        provider_id: providerId,
        error: err.message,
      });
      dispatch({ type: "provision-error", error: err.message });
    },
  });

  const handleSelect = async (selection: ProviderSelection) => {
    const { provider } = selection;
    const presetId =
      selection.kind === "openai-compatible"
        ? (selection.preset?.id ?? null)
        : null;
    const supportsOAuth = provider.supportedMethods.includes("oauth-pkce");
    const supportsApiKey = provider.supportedMethods.includes("api-key");
    const supportsProvision = provider.supportsProvision === true;

    if (supportsProvision) {
      track("ai_provider_connect_clicked", {
        provider_id: provider.id,
        method: "provision",
      });
      dispatch({ type: "select-provision", providerId: provider.id });
      provisionKey(provider.id);
      return;
    }

    if (supportsOAuth) {
      track("ai_provider_connect_clicked", {
        provider_id: provider.id,
        method: "oauth-pkce",
      });
      try {
        const result = await studio.call("AI_PROVIDER_OAUTH_URL", {
          providerId: provider.id,
          callbackUrl: `${window.location.origin}/oauth/callback/ai-provider`,
        });
        if (!result?.url) {
          throw new Error("Invalid response from AI_PROVIDER_OAUTH_URL");
        }
        dispatch({
          type: "select-oauth",
          providerId: provider.id,
          stateToken: result.stateToken,
        });
        window.open(result.url, "AiProviderOAuth", "width=600,height=700");
      } catch (err) {
        toast.error(
          t("settings.connectProviderDialog.startOAuthFailedMessage", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    if (supportsApiKey) {
      track("ai_provider_connect_clicked", {
        provider_id: provider.id,
        ...(presetId !== null ? { preset_id: presetId } : {}),
        method: "api-key",
      });
      dispatch({
        type: "select-form",
        providerId: provider.id,
        presetId,
      });
    }
  };

  // When initialProvider is set, auto-trigger selection once the dialog opens to grid state.
  const handleSelectRef = useRef(handleSelect);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  handleSelectRef.current = handleSelect;
  const initialProviderRef = useRef(initialProvider);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  initialProviderRef.current = initialProvider;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (
      !initialProviderRef.current ||
      state.kind !== "grid" ||
      triggeredRef.current
    )
      return;
    triggeredRef.current = true;
    handleSelectRef.current(initialProviderRef.current);
  }, [state.kind]);

  // OAuth popup → postMessage listener. Active only while waiting for callback.
  // Narrow the dep array to discriminated primitives — using `state` directly
  // would re-subscribe on unrelated transitions, and `providers` is a fresh
  // ref from React Query each refetch. `providers` is closed over only to
  // read provider.name as a label, which is acceptable to keep slightly stale.
  const oauthStateToken =
    state.kind === "oauth-pending" ? state.stateToken : null;
  const oauthProviderId =
    state.kind === "oauth-pending" ? state.providerId : null;
  // oxlint-disable-next-line ban-use-effect/ban-use-effect, eslint-plugin-react-hooks/exhaustive-deps -- providers intentionally closed over to avoid re-subscribing on refetch
  useEffect(() => {
    if (state.kind !== "oauth-pending") return;
    let exchangeStarted = false;
    const stateToken = state.stateToken;
    const providerId = state.providerId;

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "AI_PROVIDER_OAUTH_CALLBACK") return;
      const { code, stateToken: incoming } = event.data;
      if (incoming !== stateToken) {
        toast.error(
          t("settings.connectProviderDialog.securityCheckFailedMessage"),
        );
        dispatch({ type: "oauth-failed" });
        return;
      }
      exchangeStarted = true;
      const provider = providers.find((p) => p.id === providerId);
      exchangeOAuth({
        providerId,
        code,
        stateToken,
        label: provider?.name ?? providerId,
      });
    };
    window.addEventListener("message", handleMessage);

    const timeoutId = setTimeout(() => {
      if (exchangeStarted) return;
      track("ai_provider_oauth_timeout", { provider_id: providerId });
      dispatch({ type: "oauth-failed" });
      toast.error(
        t("settings.connectProviderDialog.connectionTimedOutMessage"),
      );
    }, 120000);

    return () => {
      window.removeEventListener("message", handleMessage);
      clearTimeout(timeoutId);
    };
    // oxlint-disable-next-line eslint-plugin-react-hooks/exhaustive-deps -- providers intentionally closed over
  }, [state.kind, oauthStateToken, oauthProviderId, exchangeOAuth]);

  const currentProviderId = activeProviderId(state);
  const currentProvider = currentProviderId
    ? providers.find((p) => p.id === currentProviderId)
    : null;
  const currentPreset =
    state.kind === "form" && state.presetId ? getPreset(state.presetId) : null;
  const currentTitle =
    currentPreset?.name ??
    currentProvider?.name ??
    t("settings.connectProviderDialog.defaultTitle");
  const showBack = state.kind !== "grid" && state.kind !== "closed";
  const handleBack = () => {
    if (initialProvider) {
      close();
    } else {
      dispatch({ type: "back" });
    }
  };

  return (
    <Dialog open={state.kind !== "closed"} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {showBack && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("settings.connectProviderDialog.backButtonLabel")}
                className="h-7 w-7"
                onClick={handleBack}
              >
                <ArrowLeft size={16} />
              </Button>
            )}
            <DialogTitle>{currentTitle}</DialogTitle>
          </div>
          {state.kind === "grid" && !initialProvider && (
            <DialogDescription>
              {t("settings.connectProviderDialog.gridDescription")}
            </DialogDescription>
          )}
        </DialogHeader>

        {state.kind === "grid" && !initialProvider && (
          <ProviderGrid providers={providers} onSelect={handleSelect} />
        )}

        {state.kind === "form" &&
          (state.providerId === "openai-compatible" ? (
            <ConnectOpenAICompatibleForm
              preset={state.presetId ? getPreset(state.presetId) : undefined}
              onCancel={() => dispatch({ type: "back" })}
              onSuccess={() => {
                invalidateKeys();
                close();
              }}
            />
          ) : (
            <ConnectApiKeyForm
              providerId={state.providerId}
              onCancel={() => dispatch({ type: "back" })}
              onSuccess={() => {
                invalidateKeys();
                close();
              }}
            />
          ))}

        {state.kind === "oauth-pending" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Spinner size="lg" />
            <p className="text-sm text-muted-foreground text-center">
              {t("settings.connectProviderDialog.oauthPendingMessage")}
            </p>
          </div>
        )}

        {state.kind === "provision-pending" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Spinner size="lg" />
            <p className="text-sm text-muted-foreground">
              {t("settings.connectProviderDialog.provisionPendingMessage")}
            </p>
          </div>
        )}

        {state.kind === "provision-error" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <AlertCircle size={28} className="text-destructive" />
            <p className="text-sm text-foreground text-center">{state.error}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: "back" })}
              >
                {t("settings.connectProviderDialog.backButton")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  dispatch({ type: "retry-provision" });
                  provisionKey(state.providerId);
                }}
              >
                {t("settings.connectProviderDialog.retryButton")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
