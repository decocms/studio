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
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";
import type { OpenAICompatiblePreset } from "@/web/utils/openai-compatible-presets";

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
