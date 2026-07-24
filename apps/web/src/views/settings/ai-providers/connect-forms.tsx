import { useState } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Eye, EyeOff } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { DialogFooter } from "@deco/ui/components/dialog.tsx";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import type { StudioToolInput as ToolInput } from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import type { OpenAICompatiblePreset } from "@/utils/openai-compatible-presets";

const apiKeyFormSchema = z.object({
  label: z.string().optional(),
  apiKey: z.string().min(1, "API key is required"),
});

type ApiKeyFormData = z.infer<typeof apiKeyFormSchema>;

export function ConnectApiKeyForm({
  providerId,
  onCancel,
  onSuccess,
}: {
  providerId: string;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const t = useT();

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
      await studio.call("AI_PROVIDER_KEY_CREATE", {
        providerId:
          providerId as ToolInput<"AI_PROVIDER_KEY_CREATE">["providerId"],
        label: data.label || t("settings.connectForms.defaultKeyLabel"),
        apiKey: data.apiKey,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success(t("settings.connectForms.keySavedSuccess"));
      onSuccess();
    },
    onError: (err) => {
      toast.error(
        t("settings.connectForms.failedSaveKey", { error: err.message }),
      );
    },
  });

  return (
    <form
      onSubmit={handleSubmit((data) => createKey(data))}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.connectForms.labelField")}
        </label>
        <Input
          placeholder={t("settings.connectForms.labelPlaceholder")}
          {...register("label")}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.connectForms.apiKeyField")}
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
            aria-label={
              showKey
                ? t("settings.connectForms.hideApiKey")
                : t("settings.connectForms.showApiKey")
            }
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
          {t("settings.connectForms.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending
            ? t("settings.connectForms.saving")
            : t("settings.connectForms.saveKey")}
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

export function ConnectOpenAICompatibleForm({
  preset,
  onCancel,
  onSuccess,
}: {
  preset?: OpenAICompatiblePreset;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const t = useT();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<OpenAICompatibleFormData>({
    resolver: zodResolver(openaiCompatibleFormSchema),
    defaultValues: {
      label: "",
      baseUrl: preset?.defaultBaseUrl ?? "",
      apiKey: "",
    },
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
      await studio.call("AI_PROVIDER_KEY_CREATE", {
        providerId: "openai-compatible",
        label: data.label || preset?.name || data.baseUrl,
        apiKey: encodedKey,
        ...(preset ? { presetId: preset.id } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success(t("settings.connectForms.connectionSavedSuccess"));
      onSuccess();
    },
    onError: (err) => {
      toast.error(
        t("settings.connectForms.failedSaveConnection", { error: err.message }),
      );
    },
  });

  const labelPlaceholder = preset
    ? t("settings.connectForms.labelPlaceholderPreset", { name: preset.name })
    : t("settings.connectForms.labelPlaceholderOpenAiCompatible");
  const baseUrlPlaceholder =
    preset?.baseUrlPlaceholder ?? t("settings.connectForms.baseUrlPlaceholder");

  return (
    <form
      onSubmit={handleSubmit((data) => createKey(data))}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.connectForms.labelField")}
        </label>
        <Input
          placeholder={labelPlaceholder}
          {...register("label")}
          className="h-8 text-sm"
        />
      </div>
      {preset?.defaultBaseUrl ? (
        <input type="hidden" {...register("baseUrl")} />
      ) : (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.connectForms.baseUrlField")}
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
      )}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.connectForms.apiKeyField")}{" "}
          <span className="text-muted-foreground/60">
            (
            {preset?.apiKeyRecommended
              ? t("settings.connectForms.recommended")
              : t("settings.connectForms.optional")}
            )
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
            aria-label={
              showKey
                ? t("settings.connectForms.hideApiKey")
                : t("settings.connectForms.showApiKey")
            }
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
          {t("settings.connectForms.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending
            ? t("settings.connectForms.saving")
            : t("settings.connectForms.saveConnection")}
        </Button>
      </DialogFooter>
    </form>
  );
}
