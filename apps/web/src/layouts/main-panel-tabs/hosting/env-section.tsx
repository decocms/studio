/**
 * Environment variables. The control-plane PUT is a REPLACE-SET: the body is
 * the complete desired list, so every add, edit and delete recomputes it from
 * the current vars and PUTs the whole thing.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Code02,
  Eye,
  EyeOff,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import {
  errorText,
  mutateJson,
  sameEnvVar,
  type EnvScope,
  type EnvVar,
} from "./api";
import {
  ConfirmDeleteDialog,
  HostingSection,
  ListCard,
  ListMessage,
  ListRow,
  RowsSkeleton,
  ScopeBadge,
} from "./shell";

type EnvKey = { name: string; scope: EnvScope };

function ScopeSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: EnvScope;
  onChange: (scope: EnvScope) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "build" ? "build" : "runtime")}
      disabled={disabled}
    >
      <SelectTrigger className={cn("h-8", className)}>
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
  );
}

export function EnvSection({
  base,
  orgSlug,
  site,
  envVars,
  codeVars,
  isLoading,
  error,
}: {
  base: string;
  orgSlug: string;
  site: string;
  envVars: EnvVar[];
  codeVars: EnvVar[];
  isLoading: boolean;
  error: unknown;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addScope, setAddScope] = useState<EnvScope>("runtime");
  const [editingKey, setEditingKey] = useState<EnvKey | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<EnvKey | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const toggleRevealed = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const envMutation = useMutation({
    mutationFn: (vars: EnvVar[]) => mutateJson(`${base}/env`, "PUT", { vars }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.hostingEnv(orgSlug, site),
      });
      toast.success(t("mainPanelTabs.hostingTab.toastEnvSaved"));
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const handleAdd = () => {
    const name = addName.trim();
    if (!name) {
      toast.error(t("mainPanelTabs.hostingTab.errorEnvNameRequired"));
      return;
    }
    // A name may exist once per scope, so the dup check is per (name, scope).
    if (envVars.some((v) => sameEnvVar(v, { name, scope: addScope }))) {
      toast.error(t("mainPanelTabs.hostingTab.errorEnvNameDuplicate"));
      return;
    }
    envMutation.mutate(
      [...envVars, { name, value: addValue, scope: addScope }],
      {
        onSuccess: () => {
          setAddOpen(false);
          setAddName("");
          setAddValue("");
          setAddScope("runtime");
        },
      },
    );
  };

  const handleSaveEdit = (target: EnvKey) => {
    envMutation.mutate(
      envVars.map((v) =>
        sameEnvVar(v, target)
          ? { name: target.name, value: editValue, scope: target.scope }
          : v,
      ),
      { onSuccess: () => setEditingKey(null) },
    );
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    envMutation.mutate(
      envVars.filter((v) => !sameEnvVar(v, deleteTarget)),
      { onSuccess: () => setDeleteTarget(null) },
    );
  };

  const pending = envMutation.isPending;

  const resetAddForm = () => {
    setAddName("");
    setAddValue("");
    setAddScope("runtime");
  };

  const addButton = (
    <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
      <Plus />
      {t("mainPanelTabs.hostingTab.addVariable")}
    </Button>
  );

  return (
    <HostingSection
      title={t("mainPanelTabs.hostingTab.env")}
      actions={
        envVars.length > 0 || codeVars.length > 0 ? addButton : undefined
      }
    >
      {isLoading ? (
        <RowsSkeleton />
      ) : error ? (
        <ListCard>
          <ListMessage>{t("mainPanelTabs.hostingTab.envError")}</ListMessage>
        </ListCard>
      ) : envVars.length === 0 && codeVars.length === 0 ? (
        <ListCard>
          <EmptyState
            icon={<Code02 className="size-5" />}
            title={t("mainPanelTabs.hostingTab.noEnv")}
            className="py-10"
            buttonComponent={addButton}
          />
        </ListCard>
      ) : (
        <ListCard>
          {envVars.map((e) => {
            const scope: EnvScope = e.scope === "build" ? "build" : "runtime";
            const rowKey = `${e.name}:${scope}`;
            const isEditing =
              editingKey?.name === e.name && editingKey?.scope === scope;
            const isRevealed = revealed.has(rowKey);
            return (
              <ListRow key={rowKey}>
                <div className="flex min-w-0 flex-1 basis-0 items-center gap-2">
                  <div className="w-20 shrink-0">
                    <ScopeBadge scope={scope} />
                  </div>
                  <span className="truncate font-mono text-xs">{e.name}</span>
                </div>
                <div className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-2">
                  {isEditing ? (
                    <>
                      <Input
                        value={editValue}
                        onChange={(ev) => setEditValue(ev.target.value)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter")
                            handleSaveEdit({ name: e.name, scope });
                          if (ev.key === "Escape") setEditingKey(null);
                        }}
                        autoFocus
                        className="h-8 font-mono text-xs"
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSaveEdit({ name: e.name, scope })}
                        disabled={pending}
                      >
                        {t("mainPanelTabs.hostingTab.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingKey(null)}
                        disabled={pending}
                      >
                        {t("mainPanelTabs.hostingTab.cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <IconButton
                        label={t(
                          isRevealed
                            ? "mainPanelTabs.hostingTab.hideValue"
                            : "mainPanelTabs.hostingTab.showValue",
                        )}
                        onClick={() => toggleRevealed(rowKey)}
                        className="text-muted-foreground"
                      >
                        {isRevealed ? <EyeOff /> : <Eye />}
                      </IconButton>
                      {isRevealed ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingKey({ name: e.name, scope });
                            setEditValue(e.value);
                          }}
                          title={t("mainPanelTabs.hostingTab.editValue")}
                          className="min-w-0 truncate rounded px-1.5 py-0.5 text-right font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {e.value || "—"}
                        </button>
                      ) : (
                        <span className="min-w-0 truncate px-1.5 py-0.5 text-right font-mono text-xs text-muted-foreground/60">
                          {e.value ? "••••••••••" : "—"}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <IconButton
                  label={t("mainPanelTabs.hostingTab.deleteVariable")}
                  onClick={() => setDeleteTarget({ name: e.name, scope })}
                  disabled={pending}
                  className="text-muted-foreground"
                >
                  <Trash01 />
                </IconButton>
              </ListRow>
            );
          })}

          {codeVars.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground hover:bg-muted/40"
                >
                  <ChevronRight className="size-4 transition-transform duration-200 group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
                  <Code02 className="size-4" />
                  {t("mainPanelTabs.hostingTab.codeVarsToggle", {
                    count: String(codeVars.length),
                  })}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="divide-y divide-border/60 border-t border-border bg-muted/30">
                  {codeVars.map((e) => (
                    <div
                      key={e.name}
                      className="flex items-center gap-3 px-4 py-2 font-mono text-xs"
                    >
                      <span className="flex-1 basis-0 truncate">{e.name}</span>
                      <span className="flex-1 basis-0 truncate text-right text-muted-foreground">
                        {e.value}
                      </span>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </ListCard>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetAddForm();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("mainPanelTabs.hostingTab.addVariable")}
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
              <Label htmlFor="env-name">
                {t("mainPanelTabs.hostingTab.colName")}
              </Label>
              <Input
                id="env-name"
                placeholder={t("mainPanelTabs.hostingTab.envNamePlaceholder")}
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="env-value">
                {t("mainPanelTabs.hostingTab.colValue")}
              </Label>
              <Input
                id="env-value"
                placeholder={t("mainPanelTabs.hostingTab.envValuePlaceholder")}
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
                disabled={pending}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("mainPanelTabs.hostingTab.secretScope")}</Label>
              <ScopeSelect
                value={addScope}
                onChange={setAddScope}
                disabled={pending}
                className="w-full"
              />
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
                onClick={() => {
                  setAddOpen(false);
                  resetAddForm();
                }}
                disabled={pending}
              >
                {t("mainPanelTabs.hostingTab.cancel")}
              </Button>
              <Button type="submit" disabled={pending || !addName.trim()}>
                {pending
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
        title={t("mainPanelTabs.hostingTab.confirmDeleteVariableTitle")}
        description={t(
          "mainPanelTabs.hostingTab.confirmDeleteVariableDescription",
          { name: deleteTarget?.name ?? "" },
        )}
        confirmLabel={t("mainPanelTabs.hostingTab.deleteVariable")}
        pending={pending}
        onConfirm={handleConfirmDelete}
      />
    </HostingSection>
  );
}
