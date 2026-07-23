import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ptBR as ptBRLocale } from "date-fns/locale/pt-BR";
import { toast } from "sonner";
import { Edit01, Trash01 } from "@untitledui/icons";
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
  useProjectContext,
  type AiProviderInfo,
  type AiProviderKey,
} from "@decocms/mesh-sdk";
import { useStudioTools } from "@/web/lib/studio-tools";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { KEYS } from "@/web/lib/query-keys";
import {
  getPreset,
  type OpenAICompatiblePreset,
} from "@/web/utils/openai-compatible-presets";
import { EditProviderKeyDialog } from "./edit-provider-dialog";
import { useT } from "@/web/i18n/use-t.ts";

interface ProviderKeyRowProps {
  providerKey: AiProviderKey;
  provider: AiProviderInfo;
}

export function ProviderKeyRow({ providerKey, provider }: ProviderKeyRowProps) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const t = useT();
  const [preferences] = usePreferences();
  const locale = preferences.language === "pt-BR" ? ptBRLocale : undefined;

  const isOpenAICompatible = provider.id === "openai-compatible";

  const preset: OpenAICompatiblePreset | undefined =
    isOpenAICompatible && providerKey.presetId
      ? getPreset(providerKey.presetId)
      : undefined;

  const displayName = preset
    ? preset.name
    : isOpenAICompatible
      ? t("settings.aiProviders.customOpenAiCompatible")
      : provider.name;
  const logo = preset?.logo ?? provider.logo;

  const description = (() => {
    if (isOpenAICompatible) {
      return providerKey.label;
    }
    return `${providerKey.label} · added ${formatDistanceToNow(new Date(providerKey.createdAt), { locale })} ago`;
  })();

  const { mutate: deleteKey, isPending: isDeleting } = useMutation({
    mutationFn: async () => {
      await studio.call("AI_PROVIDER_KEY_DELETE", { keyId: providerKey.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviderKeys(org.id) });
      queryClient.invalidateQueries({ queryKey: KEYS.aiProviders(org.id) });
      queryClient.invalidateQueries({
        queryKey: KEYS.aiProviderModels(org.id, providerKey.id),
      });
      toast.success(t("settings.providerKeyRow.keyDeleted"));
      setConfirmDelete(false);
    },
    onError: (err) =>
      toast.error(
        t("settings.providerKeyRow.failedToDeleteKey", { error: err.message }),
      ),
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
        title={displayName}
        description={description}
        action={
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("settings.providerKeyRow.editProviderKey")}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setEditOpen(true)}
            >
              <Edit01 size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("settings.providerKeyRow.deleteProviderKey")}
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              disabled={isDeleting}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash01 size={14} />
            </Button>
          </div>
        }
      />

      <EditProviderKeyDialog
        providerKey={providerKey}
        provider={provider}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.providerKeyRow.deleteApiKey")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/* TODO(i18n): rich text — bolded label can't round-trip through t()'s plain-string interpolation */}
              This action cannot be undone. This will permanently delete{" "}
              <span className="font-medium text-foreground">
                {providerKey.label}
              </span>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.providerKeyRow.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteKey()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.providerKeyRow.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
