import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Eye, EyeOff } from "@untitledui/icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  useProjectContext,
  type AiProviderInfo,
  type AiProviderKey,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import { useStudioTools } from "@/web/lib/studio-tools";
import { useT, type TFunction } from "@/web/i18n/use-t.ts";
import {
  getPreset,
  type OpenAICompatiblePreset,
} from "@/web/utils/openai-compatible-presets";

interface EditProviderKeyDialogProps {
  providerKey: AiProviderKey;
  provider: AiProviderInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const createEditFormSchema = (t: TFunction) =>
  z.object({
    label: z
      .string()
      .min(1, t("settings.editProviderDialog.labelRequired"))
      .max(100),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
  });

type EditFormData = z.infer<ReturnType<typeof createEditFormSchema>>;

/**
 * The stored apiKey blob for openai-compatible keys encodes {baseUrl, apiKey}
 * together. If the base URL changes without a freshly typed apiKey, the
 * previous plaintext key isn't available client-side (only a masked preview
 * is) to re-encode — so submitting would silently wipe the stored credential.
 */
export function needsApiKeyForBaseUrlChange({
  isOpenAICompatible,
  baseUrl,
  currentBaseUrl,
  apiKey,
}: {
  isOpenAICompatible: boolean;
  baseUrl?: string;
  currentBaseUrl?: string;
  apiKey?: string;
}): boolean {
  return (
    isOpenAICompatible && !!baseUrl && baseUrl !== currentBaseUrl && !apiKey
  );
}

interface EditFormProps {
  providerKey: AiProviderKey;
  provider: AiProviderInfo;
  preset?: OpenAICompatiblePreset;
  maskedKey: string;
  currentLabel: string;
  currentBaseUrl?: string;
  onCancel: () => void;
  onSuccess: () => void;
}

function EditForm({
  providerKey,
  provider,
  preset,
  maskedKey,
  currentLabel,
  currentBaseUrl,
  onCancel,
  onSuccess,
}: EditFormProps) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const t = useT();
  const [showKey, setShowKey] = useState(false);

  const isOpenAICompatible = provider.id === "openai-compatible";
  const supportsApiKey = provider.supportedMethods.includes("api-key");

  const editFormSchema = createEditFormSchema(t);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<EditFormData>({
    resolver: zodResolver(editFormSchema),
    defaultValues: {
      label: currentLabel,
      apiKey: "",
      baseUrl: currentBaseUrl ?? "",
    },
  });

  const typedApiKey = watch("apiKey") ?? "";

  const { mutate: save, isPending } = useMutation({
    mutationFn: async (data: EditFormData) => {
      let apiKeyValue: string | undefined;

      if (data.apiKey) {
        if (isOpenAICompatible) {
          apiKeyValue = JSON.stringify({
            baseUrl: data.baseUrl || currentBaseUrl || "",
            apiKey: data.apiKey,
          });
        } else {
          apiKeyValue = data.apiKey;
        }
      }

      await studio.call("AI_PROVIDER_KEY_UPDATE", {
        keyId: providerKey.id,
        label: data.label,
        ...(apiKeyValue !== undefined ? { apiKey: apiKeyValue } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success(t("settings.editProviderDialog.providerUpdated"));
      onSuccess();
    },
    onError: (err) =>
      toast.error(
        t("settings.editProviderDialog.failedToUpdate", { error: err.message }),
      ),
  });

  return (
    <form
      onSubmit={handleSubmit((data) => {
        if (
          needsApiKeyForBaseUrlChange({
            isOpenAICompatible,
            baseUrl: data.baseUrl,
            currentBaseUrl,
            apiKey: data.apiKey,
          })
        ) {
          setError("apiKey", {
            message: t(
              "settings.editProviderDialog.apiKeyRequiredForBaseUrlChange",
            ),
          });
          return;
        }
        save(data);
      })}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.editProviderDialog.label")}
        </label>
        <Input
          placeholder={t("settings.editProviderDialog.labelPlaceholder")}
          {...register("label")}
          className="h-8 text-sm"
        />
        {errors.label && (
          <p className="text-xs text-destructive">{errors.label.message}</p>
        )}
      </div>

      {isOpenAICompatible && !preset?.defaultBaseUrl && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.editProviderDialog.baseUrl")}
          </label>
          <Input
            type="url"
            placeholder={
              preset?.baseUrlPlaceholder ??
              t("settings.editProviderDialog.baseUrlPlaceholder")
            }
            {...register("baseUrl")}
            className="h-8 text-sm"
          />
        </div>
      )}

      {supportsApiKey && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.editProviderDialog.apiKey")}{" "}
            <span className="text-muted-foreground/60">
              ({t("settings.editProviderDialog.leaveBlankHint")})
            </span>
          </label>
          <div className="relative">
            <Input
              type={showKey && typedApiKey ? "text" : "password"}
              placeholder={maskedKey}
              {...register("apiKey")}
              className="ph-no-capture h-8 text-sm pr-8"
            />
            {typedApiKey && (
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                aria-label={
                  showKey
                    ? t("settings.editProviderDialog.hideApiKey")
                    : t("settings.editProviderDialog.showApiKey")
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
          </div>
          {errors.apiKey && (
            <p className="text-xs text-destructive">{errors.apiKey.message}</p>
          )}
        </div>
      )}

      {preset?.helpText && (
        <p className="text-xs text-muted-foreground">{preset.helpText}</p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          {t("settings.editProviderDialog.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending
            ? t("settings.editProviderDialog.saving")
            : t("settings.editProviderDialog.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditProviderKeyDialog({
  providerKey,
  provider,
  open,
  onOpenChange,
}: EditProviderKeyDialogProps) {
  const t = useT();
  const studio = useStudioTools();

  const preset: OpenAICompatiblePreset | undefined =
    provider.id === "openai-compatible" && providerKey.presetId
      ? getPreset(providerKey.presetId)
      : undefined;

  const displayName = preset?.name ?? provider.name;

  const { data: preview, isLoading } = useQuery({
    queryKey: KEYS.aiProviderKeyPreview(providerKey.id),
    queryFn: () =>
      studio.call("AI_PROVIDER_KEY_PREVIEW", { keyId: providerKey.id }),
    enabled: open,
    staleTime: 0,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("settings.editProviderDialog.editTitle", { name: displayName })}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !preview ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <EditForm
            providerKey={providerKey}
            provider={provider}
            preset={preset}
            maskedKey={preview.maskedKey}
            currentLabel={preview.label}
            currentBaseUrl={preview.baseUrl}
            onCancel={() => onOpenChange(false)}
            onSuccess={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
