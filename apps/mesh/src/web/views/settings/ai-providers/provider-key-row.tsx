import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Edit01, Trash01, Check, X } from "@untitledui/icons";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { SettingsCardItem } from "@/web/components/settings/settings-section";
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

interface ProviderKeyRowProps {
  providerKey: AiProviderKey;
  provider: AiProviderInfo;
}

export function ProviderKeyRow({ providerKey, provider }: ProviderKeyRowProps) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(providerKey.label);

  const isCli = provider.supportedMethods.includes("cli-activate");
  const isOpenAICompatible = provider.id === "openai-compatible";

  const preset: OpenAICompatiblePreset | undefined =
    isOpenAICompatible && providerKey.presetId
      ? OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === providerKey.presetId)
      : undefined;

  const displayName = preset
    ? preset.name
    : isOpenAICompatible
      ? "Custom OpenAI-compatible"
      : provider.name;
  const logo = preset?.logo ?? provider.logo;

  const description = (() => {
    if (isCli) return "Authenticated via CLI";
    if (isOpenAICompatible) {
      return providerKey.label;
    }
    return `${providerKey.label} · added ${formatDistanceToNow(new Date(providerKey.createdAt))} ago`;
  })();

  const { mutate: updateLabel, isPending: isUpdating } = useMutation({
    mutationFn: async (label: string) => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_UPDATE",
        arguments: { keyId: providerKey.id, label },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      setEditing(false);
    },
    onError: () => toast.error("Failed to update key label"),
  });

  const { mutate: deleteKey, isPending: isDeleting } = useMutation({
    mutationFn: async () => {
      await client.callTool({
        name: "AI_PROVIDER_KEY_DELETE",
        arguments: { keyId: providerKey.id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderModels(org.id, providerKey.id),
      });
      toast.success("Key deleted");
      setConfirmDelete(false);
    },
    onError: (err) => toast.error(`Failed to delete key: ${err.message}`),
  });

  const startEdit = () => {
    setDraftLabel(providerKey.label);
    setEditing(true);
  };

  const submitEdit = () => {
    const trimmed = draftLabel.trim();
    if (!trimmed) return;
    updateLabel(trimmed);
  };

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
          editing ? (
            <input
              autoFocus
              className="font-medium bg-transparent border-b border-border outline-none w-full"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitEdit();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            displayName
          )
        }
        description={editing ? null : description}
        action={
          <div className="flex items-center gap-0.5">
            {editing ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  disabled={isUpdating || !draftLabel.trim()}
                  onClick={submitEdit}
                >
                  <Check size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditing(false)}
                >
                  <X size={14} />
                </Button>
              </>
            ) : (
              <>
                {!isCli && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={startEdit}
                  >
                    <Edit01 size={14} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  disabled={isDeleting}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash01 size={14} />
                </Button>
              </>
            )}
          </div>
        }
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API Key</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {providerKey.label}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteKey()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
