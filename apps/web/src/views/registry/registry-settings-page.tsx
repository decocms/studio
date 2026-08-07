import { useState } from "react";
import { useProjectContext } from "@/sdk";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { useCopy } from "@decocms/ui/hooks/use-copy.ts";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  Check,
  Copy01,
  Eye,
  EyeOff,
  Key01,
  Loading01,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { PLUGIN_ID } from "@decocms/shared/registry/constants";
import { useImageUpload } from "@/hooks/registry/use-image-upload";
import {
  usePublishApiKeyMutations,
  usePublishApiKeys,
  useRegistryConfig,
  useRegistryItems,
} from "@/hooks/registry/use-registry";
import { useT } from "@/i18n/use-t.ts";
import { ImageUpload } from "./image-upload";

/**
 * Settings page for the Private Registry plugin.
 *
 * Toggles and selects auto-save on change. Text inputs save on blur.
 * All controls are disabled while a save is in flight to prevent
 * concurrent mutations.
 */
interface RegistrySettingsPageProps {
  revealedKey: string | null;
  onRevealedKeyChange: (key: string | null) => void;
}

export default function RegistrySettingsPage({
  revealedKey,
  onRevealedKeyChange,
}: RegistrySettingsPageProps) {
  const t = useT();
  const { org } = useProjectContext();
  const { uploadImage, isUploading: isUploadingIcon } = useImageUpload();
  const {
    registryName,
    registryIcon,
    acceptPublishRequests,
    requireApiToken,
    storePrivateOnly,
    rateLimitEnabled,
    rateLimitWindow,
    rateLimitMax,
    isSaving,
    updateConfig,
  } = useRegistryConfig(PLUGIN_ID);

  // ── Local state for text inputs (controlled input during typing, saved on blur) ──
  // Sync drafts when server values change (e.g. after initial load completes).
  const [nameDraft, setNameDraft] = useState(registryName);
  const [prevName, setPrevName] = useState(registryName);
  if (registryName !== prevName) {
    setPrevName(registryName);
    setNameDraft(registryName);
  }

  const [iconDraft, setIconDraft] = useState(registryIcon);
  const [prevIcon, setPrevIcon] = useState(registryIcon);
  if (registryIcon !== prevIcon) {
    setPrevIcon(registryIcon);
    setIconDraft(registryIcon);
  }

  const [rateLimitMaxDraft, setRateLimitMaxDraft] = useState(
    String(rateLimitMax),
  );
  const [prevRateLimitMax, setPrevRateLimitMax] = useState(rateLimitMax);
  if (rateLimitMax !== prevRateLimitMax) {
    setPrevRateLimitMax(rateLimitMax);
    setRateLimitMaxDraft(String(rateLimitMax));
  }

  // ── API key management ──
  const apiKeysQuery = usePublishApiKeys();
  const { generateMutation, revokeMutation } = usePublishApiKeyMutations();
  const [newKeyName, setNewKeyName] = useState("");
  const [showRevealedKey, setShowRevealedKey] = useState(false);
  const [keyToDelete, setKeyToDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const { handleCopy: handleCopyPublicUrl, copied: copiedPublicUrl } =
    useCopy();
  const { handleCopy: handleCopyPublishUrl, copied: copiedPublishUrl } =
    useCopy();
  const { handleCopy: handleCopyRevealedKey, copied: copiedRevealedKey } =
    useCopy();

  const itemsQuery = useRegistryItems({
    search: "",
    tags: [],
    categories: [],
    limit: 50,
  });
  const publicStoreUrl = `${window.location.origin}/org/${org.slug}/registry/mcp`;
  const loadedItems =
    itemsQuery.data?.pages.flatMap((page) => page.items ?? []) ?? [];
  const publicCount = loadedItems.filter((item) => item.is_public).length;

  const publishRequestUrl = `${window.location.origin}/org/${org.slug}/registry/publish-request`;
  const revealedKeyPrefix = revealedKey?.slice(0, 12) ?? null;
  const hasRevealedKeyInList = Boolean(
    revealedKeyPrefix &&
      (apiKeysQuery.data?.items ?? []).some(
        (apiKey) => apiKey.prefix === revealedKeyPrefix,
      ),
  );

  const disabled = isSaving || isUploadingIcon;

  const handleNameBlur = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === registryName) return;
    updateConfig({ registryName: trimmed });
  };

  const handleRateLimitMaxBlur = () => {
    const parsed = Number.parseInt(rateLimitMaxDraft, 10);
    const clamped = Number.isFinite(parsed) && parsed >= 1 ? parsed : 100;
    setRateLimitMaxDraft(String(clamped));
    if (clamped === rateLimitMax) return;
    updateConfig({ rateLimitMax: clamped });
  };

  const handleIconFileUpload = async (file: File) => {
    if (!file) return;
    const extension = file.name.split(".").pop() || "png";
    const iconPath = `registry/${org.id}/identity/icon.${extension}`;
    const url = await uploadImage(file, iconPath);

    if (url) {
      setIconDraft(url);
      updateConfig({ registryIcon: url });
    } else {
      toast.error(t("registry.registrySettingsPage.failedUploadIcon"));
    }
  };

  const handleGenerateKey = async () => {
    const name = newKeyName.trim();
    if (!name) return;
    try {
      const result = await generateMutation.mutateAsync(name);
      if (result?.key) {
        onRevealedKeyChange(result.key);
        setShowRevealedKey(false);
        setNewKeyName("");
        toast.success(t("registry.registrySettingsPage.apiKeyGenerated"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("registry.registrySettingsPage.failedGenerateApiKey"),
      );
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    try {
      await revokeMutation.mutateAsync(keyId);
      onRevealedKeyChange(null);
      setKeyToDelete(null);
      toast.success(t("registry.registrySettingsPage.apiKeyRevoked"));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("registry.registrySettingsPage.failedRevokeApiKey"),
      );
    }
  };

  return (
    <div className="h-full overflow-auto px-4 md:px-6 py-4">
      <div className="grid grid-cols-1 gap-4 items-start xl:grid-cols-2">
        <div className="grid gap-4 min-w-0 content-start">
          <Card className="min-w-0 p-4 grid gap-4 content-start">
            <div>
              <h3 className="text-base font-semibold">
                {t("registry.registrySettingsPage.registryIdentity")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("registry.registrySettingsPage.configureNameIcon")}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="identity-name">
                {t("registry.registrySettingsPage.name")}
              </Label>
              <Input
                id="identity-name"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={handleNameBlur}
                disabled={disabled}
                placeholder={t("registry.registrySettingsPage.namePlaceholder")}
              />
            </div>

            <ImageUpload
              value={iconDraft}
              onChange={setIconDraft}
              onBlur={() => {
                const trimmed = iconDraft.trim();
                if (trimmed === registryIcon) return;
                updateConfig({ registryIcon: trimmed });
              }}
              onFileUpload={handleIconFileUpload}
              isUploading={isUploadingIcon}
            />
          </Card>
        </div>

        <div className="grid gap-4 min-w-0 content-start">
          <Card className="min-w-0 p-4 grid gap-3 content-start">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold">
                  {t("registry.registrySettingsPage.publicRegistry")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("registry.registrySettingsPage.publicRegistryDescription")}
                </p>
              </div>
              <Badge variant="secondary">
                {publicCount}{" "}
                {publicCount === 1
                  ? t("registry.registrySettingsPage.publicItem")
                  : t("registry.registrySettingsPage.publicItems")}
              </Badge>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 flex items-center gap-2 min-w-0">
              <code className="text-xs font-mono break-all leading-5 min-w-0 flex-1 select-all">
                {publicStoreUrl}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => handleCopyPublicUrl(publicStoreUrl)}
              >
                {copiedPublicUrl ? <Check size={14} /> : <Copy01 size={14} />}
              </Button>
            </div>
          </Card>

          <Card className="min-w-0 p-4 grid gap-3 content-start">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold">
                  {t("registry.registrySettingsPage.storeVisibility")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "registry.registrySettingsPage.storeVisibilityDescription",
                  )}
                </p>
              </div>
              <Switch
                id="store-private-only"
                checked={storePrivateOnly}
                onCheckedChange={(checked) =>
                  updateConfig({ storePrivateOnly: checked })
                }
                disabled={disabled}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("registry.registrySettingsPage.storeVisibilityHelp")}
            </p>
          </Card>

          <Card className="min-w-0 p-4 grid gap-3 content-start">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold">
                  {t("registry.registrySettingsPage.publishRequests")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "registry.registrySettingsPage.publishRequestsDescription",
                  )}
                </p>
              </div>
              <Switch
                id="accept-publish-requests"
                checked={acceptPublishRequests}
                onCheckedChange={(checked) =>
                  updateConfig({ acceptPublishRequests: checked })
                }
                disabled={disabled}
              />
            </div>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 flex items-center gap-2 min-w-0">
              <code className="text-xs font-mono break-all leading-5 min-w-0 flex-1 select-all">
                {publishRequestUrl}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => handleCopyPublishUrl(publishRequestUrl)}
              >
                {copiedPublishUrl ? <Check size={14} /> : <Copy01 size={14} />}
              </Button>
            </div>

            {/* ── Require API Token ── */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
              <div>
                <Label className="text-sm font-medium">
                  {t("registry.registrySettingsPage.requireApiToken")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("registry.registrySettingsPage.requireApiTokenHelp")}
                </p>
              </div>
              <Switch
                id="require-api-token"
                checked={requireApiToken}
                onCheckedChange={(checked) =>
                  updateConfig({ requireApiToken: checked })
                }
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
              <div>
                <Label className="text-sm font-medium">
                  {t("registry.registrySettingsPage.rateLimit")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("registry.registrySettingsPage.rateLimitHelp")}
                </p>
              </div>
              <Switch
                id="publish-rate-limit"
                checked={rateLimitEnabled}
                onCheckedChange={(checked) =>
                  updateConfig({ rateLimitEnabled: checked })
                }
                disabled={disabled}
              />
            </div>
            {rateLimitEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label
                    htmlFor="rate-limit-max"
                    className="text-sm font-medium"
                  >
                    {t("registry.registrySettingsPage.maxRequests")}
                  </Label>
                  <Input
                    id="rate-limit-max"
                    inputMode="numeric"
                    min={1}
                    type="number"
                    value={rateLimitMaxDraft}
                    onChange={(event) =>
                      setRateLimitMaxDraft(event.target.value)
                    }
                    onBlur={handleRateLimitMaxBlur}
                    disabled={disabled}
                    placeholder={t(
                      "registry.registrySettingsPage.maxRequestsPlaceholder",
                    )}
                  />
                </div>
                <div className="space-y-1">
                  <Label
                    htmlFor="rate-limit-window"
                    className="text-sm font-medium"
                  >
                    {t("registry.registrySettingsPage.window")}
                  </Label>
                  <select
                    id="rate-limit-window"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                    value={rateLimitWindow}
                    onChange={(event) =>
                      updateConfig({
                        rateLimitWindow: event.target.value as
                          | "minute"
                          | "hour",
                      })
                    }
                    disabled={disabled}
                  >
                    <option value="minute">
                      {t("registry.registrySettingsPage.perMinute")}
                    </option>
                    <option value="hour">
                      {t("registry.registrySettingsPage.perHour")}
                    </option>
                  </select>
                </div>
              </div>
            )}

            {/* ── API Keys (inline) ── */}
            {acceptPublishRequests && requireApiToken && (
              <>
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <Key01 size={14} className="text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {t("registry.registrySettingsPage.apiKeys")}
                  </span>
                </div>

                {/* ── Revealed key fallback (while list refreshes) ── */}
                {revealedKey && !hasRevealedKeyInList && (
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2 grid gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {t("registry.registrySettingsPage.newKeyRefreshing")}
                    </span>
                    <Input
                      readOnly
                      value={revealedKey}
                      className="h-8 text-xs font-mono bg-background"
                    />
                  </div>
                )}

                {/* ── Generate new key ── */}
                <div className="flex items-end gap-2">
                  <div className="grid gap-1.5 flex-1">
                    <Label htmlFor="api-key-name" className="text-xs">
                      {t("registry.registrySettingsPage.keyName")}
                    </Label>
                    <Input
                      id="api-key-name"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder={t(
                        "registry.registrySettingsPage.keyNamePlaceholder",
                      )}
                      className="h-8 text-sm"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={!newKeyName.trim() || generateMutation.isPending}
                    onClick={handleGenerateKey}
                  >
                    {generateMutation.isPending ? (
                      <Loading01 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    {t("registry.registrySettingsPage.generate")}
                  </Button>
                </div>

                {/* ── Key list ── */}
                {(apiKeysQuery.data?.items?.length ?? 0) > 0 && (
                  <div className="grid gap-2">
                    {apiKeysQuery.data?.items?.map((apiKey) => (
                      <div
                        key={apiKey.id}
                        className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
                      >
                        <div className="grid gap-1 min-w-0 flex-1">
                          <span className="text-sm font-medium truncate leading-none">
                            {apiKey.name}
                          </span>
                          {revealedKeyPrefix === apiKey.prefix ? (
                            <Input
                              readOnly
                              value={
                                showRevealedKey
                                  ? (revealedKey ?? "")
                                  : "••••••••••••••••••••••••••••••••••••••••••••••••••••"
                              }
                              className="h-8 text-xs font-mono bg-muted/20"
                            />
                          ) : (
                            <Input
                              readOnly
                              value={`${apiKey.prefix}••••••••`}
                              className="h-8 text-xs font-mono bg-muted/20 text-muted-foreground"
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {revealedKeyPrefix === apiKey.prefix && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() =>
                                  setShowRevealedKey((prev) => !prev)
                                }
                              >
                                {showRevealedKey ? (
                                  <EyeOff size={14} />
                                ) : (
                                  <Eye size={14} />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                disabled={!revealedKey}
                                onClick={() =>
                                  revealedKey &&
                                  handleCopyRevealedKey(revealedKey)
                                }
                              >
                                {copiedRevealedKey ? (
                                  <Check size={14} />
                                ) : (
                                  <Copy01 size={14} />
                                )}
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                            disabled={revokeMutation.isPending}
                            onClick={() =>
                              setKeyToDelete({
                                id: apiKey.id,
                                name: apiKey.name,
                              })
                            }
                          >
                            <Trash01 size={14} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
      <AlertDialog
        open={Boolean(keyToDelete)}
        onOpenChange={(open) => {
          if (!open && !revokeMutation.isPending) {
            setKeyToDelete(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("registry.registrySettingsPage.revokeApiKeyTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("registry.registrySettingsPage.revokeApiKeyDescription", {
                keyName: keyToDelete?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>
              {t("registry.registrySettingsPage.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!keyToDelete || revokeMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => keyToDelete && handleRevokeKey(keyToDelete.id)}
            >
              {revokeMutation.isPending
                ? t("registry.registrySettingsPage.revoking")
                : t("registry.registrySettingsPage.revokeKey")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
