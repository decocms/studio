import { Suspense, useState } from "react";
import { AlertCircle, HardDrive, Plus, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { useT } from "@/web/i18n/use-t.ts";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import { SettingsPage } from "@/web/components/settings/settings-section";
import {
  type FileConfigInfo,
  useCreateFileConfig,
  useDeleteFileConfig,
  useFileConfigs,
} from "@/web/hooks/use-file-configs";

/**
 * MCP tool errors arrive as Error messages like
 * `Invalid arguments for tool FILE_CONFIG_CREATE: [ {...zod issues...} ]`.
 * Dumping that into a toast is unreadable, so try to pull the first Zod
 * issue's `message` (or path-qualified message) out before falling back to
 * the raw text.
 */
function formatToolError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const match = err.message.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (match) {
    try {
      const issues = JSON.parse(match[0]) as Array<{
        message?: string;
        path?: Array<string | number>;
      }>;
      const first = issues[0];
      if (first?.message) {
        const path = first.path?.join(".");
        return path ? `${path}: ${first.message}` : first.message;
      }
    } catch {
      // fall through
    }
  }
  return err.message || fallback;
}

function ErrorFallback({ error }: { error: Error }) {
  const t = useT();
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        {t("settings.buckets.failedToLoadConfigs", { error: error.message })}
      </span>
    </div>
  );
}

function FileConfigRow({
  config,
  onDelete,
}: {
  config: FileConfigInfo;
  onDelete: (config: FileConfigInfo) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <HardDrive size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{config.name}</span>
            {config.credentialType === "sts-session" ? (
              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                STS
              </span>
            ) : config.credentialType === "managed" ? (
              <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                {t("settings.buckets.managed")}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground truncate">
              {config.bucket} · {config.region}
            </span>
          </div>
          {config.description ? (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {config.description}
            </p>
          ) : null}
          {config.endpoint ? (
            <p className="text-xs text-muted-foreground/80 mt-0.5 truncate font-mono">
              {config.endpoint}
              {config.forcePathStyle
                ? ` (${t("settings.buckets.pathStyle")})`
                : ""}
            </p>
          ) : null}
          {config.prefix ? (
            <p className="text-xs text-muted-foreground/80 mt-0.5 truncate font-mono">
              {t("settings.buckets.prefix", { prefix: config.prefix })}
            </p>
          ) : null}
          {config.publicUrlBase ? (
            <p className="text-xs text-muted-foreground/80 mt-0.5 truncate font-mono">
              {t("settings.buckets.public", { url: config.publicUrlBase })}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">
          {new Date(config.createdAt).toLocaleDateString()}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(config)}
          aria-label={t("settings.buckets.deleteButton", { name: config.name })}
        >
          <Trash01 size={14} />
        </Button>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <HardDrive size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">
          {t("settings.buckets.noBucketsConfigured")}
        </p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {t("settings.buckets.emptyStateDescription")}
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="mt-2">
        <Plus size={14} />
        {t("settings.buckets.addBucket")}
      </Button>
    </div>
  );
}

interface CreateFileConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateFileConfigDialog({
  open,
  onOpenChange,
}: CreateFileConfigDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [publicUrlBase, setPublicUrlBase] = useState("");
  const [credentialType, setCredentialType] = useState<
    "static" | "sts-session"
  >("static");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [refreshUrl, setRefreshUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const createConfig = useCreateFileConfig();

  function reset() {
    setName("");
    setDescription("");
    setBucket("");
    setRegion("");
    setEndpoint("");
    setForcePathStyle(false);
    setPrefix("");
    setPublicUrlBase("");
    setCredentialType("static");
    setAccessKeyId("");
    setSecretAccessKey("");
    setRefreshUrl("");
    setApiKey("");
  }

  const credentialsValid =
    credentialType === "sts-session"
      ? Boolean(refreshUrl.trim() && apiKey.trim())
      : Boolean(accessKeyId && secretAccessKey);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !bucket.trim() || !region.trim()) return;
    if (!credentialsValid) return;

    const credentialFields =
      credentialType === "sts-session"
        ? {
            credentialType: "sts-session" as const,
            refreshUrl: refreshUrl.trim(),
            apiKey: apiKey.trim(),
          }
        : {
            credentialType: "static" as const,
            accessKeyId,
            secretAccessKey,
          };

    try {
      await createConfig.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        bucket: bucket.trim(),
        region: region.trim(),
        endpoint: endpoint.trim() || undefined,
        forcePathStyle,
        prefix: prefix.trim() || undefined,
        publicUrlBase: publicUrlBase.trim() || undefined,
        ...credentialFields,
      });
      toast.success(t("settings.buckets.bucketAdded", { name: name.trim() }));
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(
        formatToolError(err, t("settings.buckets.failedToAddBucket")),
      );
    }
  }

  const submitDisabled =
    createConfig.isPending ||
    !name.trim() ||
    !bucket.trim() ||
    !region.trim() ||
    !credentialsValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.buckets.addS3Bucket")}</DialogTitle>
          <DialogDescription>
            {t("settings.buckets.credentialsEncryptedDescription")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="file-config-name">
              {t("settings.buckets.nameLabel")}
            </Label>
            <Input
              id="file-config-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.buckets.namePlaceholder")}
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.buckets.nameHelperText")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="file-config-bucket">
                {t("settings.buckets.bucketLabel")}
              </Label>
              <Input
                id="file-config-bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder={t("settings.buckets.bucketPlaceholder")}
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="file-config-region">
                {t("settings.buckets.regionLabel")}
              </Label>
              <Input
                id="file-config-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder={t("settings.buckets.regionPlaceholder")}
                autoComplete="off"
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-endpoint">
              {t("settings.buckets.endpointLabel")}
            </Label>
            <Input
              id="file-config-endpoint"
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={t("settings.buckets.endpointPlaceholder")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.buckets.endpointHelperText")}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3">
            <div className="min-w-0">
              <Label htmlFor="file-config-path-style" className="text-sm">
                {t("settings.buckets.forcePathStyleLabel")}
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("settings.buckets.forcePathStyleHelperText")}
              </p>
            </div>
            <Switch
              id="file-config-path-style"
              checked={forcePathStyle}
              onCheckedChange={setForcePathStyle}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-prefix">
              {t("settings.buckets.prefixLabel")}
            </Label>
            <Input
              id="file-config-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder={t("settings.buckets.prefixPlaceholder")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.buckets.prefixHelperText")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-public-url-base">
              {t("settings.buckets.publicUrlBaseLabel")}
            </Label>
            <Input
              id="file-config-public-url-base"
              type="url"
              value={publicUrlBase}
              onChange={(e) => setPublicUrlBase(e.target.value)}
              placeholder={t("settings.buckets.publicUrlBasePlaceholder")}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.buckets.publicUrlBaseHelperText")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-credential-type">
              {t("settings.buckets.credentialsLabel")}
            </Label>
            <Select
              value={credentialType}
              onValueChange={(v) =>
                setCredentialType(v as "static" | "sts-session")
              }
            >
              <SelectTrigger
                id="file-config-credential-type"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="static">
                  {t("settings.buckets.staticKeyOption")}
                </SelectItem>
                <SelectItem value="sts-session">
                  {t("settings.buckets.temporarySessionOption")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {credentialType === "sts-session"
                ? t("settings.buckets.stsSessionHelperText")
                : t("settings.buckets.staticKeyHelperText")}
            </p>
          </div>

          {credentialType === "static" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="file-config-access-key">
                  {t("settings.buckets.accessKeyIdLabel")}
                </Label>
                <Input
                  id="file-config-access-key"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  autoComplete="off"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="file-config-secret-key">
                  {t("settings.buckets.secretAccessKeyLabel")}
                </Label>
                <Input
                  id="file-config-secret-key"
                  type="password"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="file-config-refresh-url">
                  {t("settings.buckets.refreshUrlLabel")}
                </Label>
                <Input
                  id="file-config-refresh-url"
                  type="url"
                  value={refreshUrl}
                  onChange={(e) => setRefreshUrl(e.target.value)}
                  placeholder={t("settings.buckets.refreshUrlPlaceholder")}
                  autoComplete="off"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.buckets.refreshUrlHelperText")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="file-config-api-key">
                  {t("settings.buckets.apiKeyLabel")}
                </Label>
                <Input
                  id="file-config-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.buckets.apiKeyHelperText")}
                </p>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="file-config-description">
              {t("settings.buckets.descriptionLabel")}
            </Label>
            <Textarea
              id="file-config-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("settings.buckets.descriptionPlaceholder")}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={createConfig.isPending}
            >
              {t("settings.buckets.cancelButton")}
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {createConfig.isPending
                ? t("settings.buckets.addingButton")
                : t("settings.buckets.addBucketButton")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFileConfigDialog({
  config,
  onClose,
}: {
  config: FileConfigInfo | null;
  onClose: () => void;
}) {
  const t = useT();
  const deleteConfig = useDeleteFileConfig();

  async function handleConfirm() {
    if (!config) return;
    try {
      await deleteConfig.mutateAsync(config.id);
      toast.success(t("settings.buckets.bucketRemoved", { name: config.name }));
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("settings.buckets.failedToRemoveBucket"),
      );
    }
  }

  return (
    <AlertDialog open={config !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settings.buckets.removeBucketTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings.buckets.removeBucketDescription", {
              name: config?.name ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteConfig.isPending}>
            {t("settings.buckets.cancelButton")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={deleteConfig.isPending}
          >
            {deleteConfig.isPending
              ? t("settings.buckets.removingButton")
              : t("settings.buckets.removeButton")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FilesContent() {
  const t = useT();
  const configs = useFileConfigs();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FileConfigInfo | null>(
    null,
  );

  if (configs.length === 0) {
    return (
      <>
        <EmptyState onCreate={() => setCreateOpen(true)} />
        <CreateFileConfigDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t("settings.buckets.bucketsConfigured", { count: configs.length })}
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus size={14} />
          {t("settings.buckets.addBucket")}
        </Button>
      </div>

      <section className="rounded-2xl border border-border/60 bg-background p-5">
        <div>
          {configs.map((c) => (
            <FileConfigRow key={c.id} config={c} onDelete={setPendingDelete} />
          ))}
        </div>
      </section>

      <CreateFileConfigDialog open={createOpen} onOpenChange={setCreateOpen} />
      <DeleteFileConfigDialog
        config={pendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}

export function OrgBucketsPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.buckets.pageTitle")}</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={
                    error ??
                    new Error(t("settings.buckets.failedToLoadConfigsFallback"))
                  }
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-32 w-full" />}>
                <FilesContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
