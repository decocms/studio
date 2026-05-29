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
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  type AiProviderInfo,
  type AiProviderKey,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import {
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
} from "@/web/utils/openai-compatible-presets";

interface EditProviderKeyDialogProps {
  providerKey: AiProviderKey;
  provider: AiProviderInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const editFormSchema = z.object({
  label: z.string().min(1, "Label is required").max(100),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

type EditFormData = z.infer<typeof editFormSchema>;

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
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const [showKey, setShowKey] = useState(false);

  const isOpenAICompatible = provider.id === "openai-compatible";
  const supportsApiKey = provider.supportedMethods.includes("api-key");

  const {
    register,
    handleSubmit,
    watch,
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
      } else if (
        isOpenAICompatible &&
        data.baseUrl &&
        data.baseUrl !== currentBaseUrl
      ) {
        // Base URL changed but no new API key — re-encode with existing masked key not possible.
        // We encode the new baseUrl with empty apiKey so the connection still works.
        apiKeyValue = JSON.stringify({
          baseUrl: data.baseUrl,
          apiKey: "",
        });
      }

      await client.callTool({
        name: "AI_PROVIDER_KEY_UPDATE",
        arguments: {
          keyId: providerKey.id,
          label: data.label,
          ...(apiKeyValue !== undefined ? { apiKey: apiKeyValue } : {}),
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      toast.success("Provider updated");
      onSuccess();
    },
    onError: (err) => toast.error(`Failed to update: ${err.message}`),
  });

  return (
    <form onSubmit={handleSubmit((data) => save(data))} className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          Label
        </label>
        <Input
          placeholder="e.g. Personal key"
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
            Base URL
          </label>
          <Input
            type="url"
            placeholder={
              preset?.baseUrlPlaceholder ?? "http://localhost:4000/v1"
            }
            {...register("baseUrl")}
            className="h-8 text-sm"
          />
        </div>
      )}

      {supportsApiKey && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            API key{" "}
            <span className="text-muted-foreground/60">
              (leave blank to keep current)
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
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
          </div>
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
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving..." : "Save"}
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
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const preset: OpenAICompatiblePreset | undefined =
    provider.id === "openai-compatible" && providerKey.presetId
      ? OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === providerKey.presetId)
      : undefined;

  const displayName = preset?.name ?? provider.name;

  const { data: preview, isLoading } = useQuery({
    queryKey: ["ai-provider-key-preview", providerKey.id],
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AI_PROVIDER_KEY_PREVIEW",
        arguments: { keyId: providerKey.id },
      })) as {
        structuredContent?: {
          label: string;
          maskedKey: string;
          baseUrl?: string;
        };
      };
      return result.structuredContent!;
    },
    enabled: open,
    staleTime: 0,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {displayName}</DialogTitle>
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
