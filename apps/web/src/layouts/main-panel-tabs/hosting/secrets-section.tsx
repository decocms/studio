/**
 * Secrets. Write-only on the control-plane: the list carries names only, and
 * a value is typed once, into the add dialog, and never rendered again.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock01, Plus, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { errorText, mutateJson, type EnvScope, type Secret } from "./api";
import {
  ConfirmDeleteDialog,
  HostingSection,
  ListCard,
  ListMessage,
  ListRow,
  RowsSkeleton,
  ScopeBadge,
} from "./shell";

type SecretKey = { name: string; scope: EnvScope };

export function SecretsSection({
  base,
  orgSlug,
  site,
  secrets,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  secrets: Secret[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addScope, setAddScope] = useState<EnvScope>("runtime");
  const [deleteTarget, setDeleteTarget] = useState<SecretKey | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.hostingSecrets(orgSlug, site),
    });

  const putMutation = useMutation({
    mutationFn: (input: { name: string; value: string; scope: EnvScope }) =>
      mutateJson(`${base}/secrets`, "PUT", input),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastSecretSaved"));
      setAddOpen(false);
      setAddName("");
      setAddValue("");
      setAddScope("runtime");
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const deleteMutation = useMutation({
    // A name may exist in both scopes, so DELETE carries the scope.
    mutationFn: (target: SecretKey) =>
      mutateJson(
        `${base}/secrets/${encodeURIComponent(target.name)}?scope=${target.scope}`,
        "DELETE",
      ),
    onSuccess: () => {
      invalidate();
      toast.success(t("mainPanelTabs.hostingTab.toastSecretDeleted"));
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const handleAdd = () => {
    const name = addName.trim();
    if (!name) {
      toast.error(t("mainPanelTabs.hostingTab.errorSecretNameRequired"));
      return;
    }
    if (!addValue) {
      toast.error(t("mainPanelTabs.hostingTab.errorSecretValueRequired"));
      return;
    }
    putMutation.mutate({ name, value: addValue, scope: addScope });
  };

  const addButton = (
    <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
      <Plus />
      {t("mainPanelTabs.hostingTab.addSecret")}
    </Button>
  );

  return (
    <HostingSection
      title={t("mainPanelTabs.hostingTab.secrets")}
      actions={secrets.length > 0 ? addButton : undefined}
    >
      {isLoading ? (
        <RowsSkeleton />
      ) : error ? (
        <ListCard>
          <ListMessage>
            {t("mainPanelTabs.hostingTab.secretsError")}
          </ListMessage>
        </ListCard>
      ) : secrets.length === 0 ? (
        <ListCard>
          <EmptyState
            icon={<Lock01 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.noSecrets")}
            className="py-10"
            buttonComponent={addButton}
          />
        </ListCard>
      ) : (
        <ListCard>
          {secrets.map((s) => {
            const scope: EnvScope = s.scope === "build" ? "build" : "runtime";
            return (
              <ListRow key={`${s.name}:${scope}`}>
                <Lock01 className="size-4 shrink-0 text-muted-foreground/60" />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="w-20 shrink-0">
                    <ScopeBadge scope={scope} />
                  </div>
                  <span className="truncate font-mono text-xs">{s.name}</span>
                  {s.origin === "worker" && (
                    <Badge variant="secondary">
                      {t("mainPanelTabs.hostingTab.secretOnWorker")}
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-xs text-muted-foreground/60">
                  {t("mainPanelTabs.hostingTab.secretValueHidden")}
                </span>
                <IconButton
                  label={t("mainPanelTabs.hostingTab.deleteSecret")}
                  onClick={() => setDeleteTarget({ name: s.name, scope })}
                  disabled={deleteMutation.isPending}
                  className="text-muted-foreground"
                >
                  <Trash01 />
                </IconButton>
              </ListRow>
            );
          })}
        </ListCard>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("mainPanelTabs.hostingTab.addSecretTitle")}
            </DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              handleAdd();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="secret-name">
                {t("mainPanelTabs.hostingTab.colName")}
              </Label>
              <Input
                id="secret-name"
                placeholder={t(
                  "mainPanelTabs.hostingTab.secretNamePlaceholder",
                )}
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
                disabled={putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="secret-value">
                {t("mainPanelTabs.hostingTab.colValue")}
              </Label>
              <Input
                id="secret-value"
                type="password"
                placeholder={t(
                  "mainPanelTabs.hostingTab.secretValuePlaceholder",
                )}
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                className="font-mono text-xs"
                autoComplete="new-password"
                disabled={putMutation.isPending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.hostingTab.secretScope")}</Label>
              <Select
                value={addScope}
                onValueChange={(v) =>
                  setAddScope(v === "build" ? "build" : "runtime")
                }
                disabled={putMutation.isPending}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="runtime">
                    {t("mainPanelTabs.hostingTab.secretScopeRuntime")}
                  </SelectItem>
                  <SelectItem value="build">
                    {t("mainPanelTabs.hostingTab.secretScopeBuild")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {addScope === "build"
                  ? t("mainPanelTabs.hostingTab.secretScopeBuildHint")
                  : t("mainPanelTabs.hostingTab.secretScopeRuntimeHint")}
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setAddOpen(false)}
                disabled={putMutation.isPending}
              >
                {t("mainPanelTabs.hostingTab.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={putMutation.isPending || !addName.trim() || !addValue}
              >
                {putMutation.isPending
                  ? t("mainPanelTabs.hostingTab.saving")
                  : t("mainPanelTabs.hostingTab.add")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("mainPanelTabs.hostingTab.confirmDeleteSecretTitle")}
        description={t(
          "mainPanelTabs.hostingTab.confirmDeleteSecretDescription",
          { name: deleteTarget?.name ?? "" },
        )}
        confirmLabel={t("mainPanelTabs.hostingTab.deleteSecret")}
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget);
        }}
      />
    </HostingSection>
  );
}
