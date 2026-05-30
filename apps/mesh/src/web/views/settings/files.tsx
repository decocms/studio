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
import { Switch } from "@deco/ui/components/switch.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
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
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load file configurations: {error.message}
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
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/60 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="size-9 rounded-md bg-muted flex items-center justify-center shrink-0">
          <HardDrive size={16} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{config.name}</span>
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
              {config.forcePathStyle ? " (path-style)" : ""}
            </p>
          ) : null}
          {config.prefix ? (
            <p className="text-xs text-muted-foreground/80 mt-0.5 truncate font-mono">
              prefix: {config.prefix}
            </p>
          ) : null}
          {config.publicUrlBase ? (
            <p className="text-xs text-muted-foreground/80 mt-0.5 truncate font-mono">
              public: {config.publicUrlBase}
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
          aria-label={`Delete ${config.name}`}
        >
          <Trash01 size={14} />
        </Button>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 p-10 flex flex-col items-center justify-center text-center gap-3">
      <div className="size-12 rounded-full bg-muted flex items-center justify-center">
        <HardDrive size={20} className="text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium text-sm">No buckets configured</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Add an S3-compatible bucket (AWS S3, Cloudflare R2, Google Cloud
          Storage, MinIO). Access keys are encrypted at rest and never returned
          over the API.
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="mt-2">
        <Plus size={14} />
        Add bucket
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [publicUrlBase, setPublicUrlBase] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
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
    setAccessKeyId("");
    setSecretAccessKey("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !bucket.trim() || !region.trim()) return;
    if (!accessKeyId || !secretAccessKey) return;

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
        accessKeyId,
        secretAccessKey,
      });
      toast.success(`Bucket "${name.trim()}" added`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(formatToolError(err, "Failed to add bucket"));
    }
  }

  const submitDisabled =
    createConfig.isPending ||
    !name.trim() ||
    !bucket.trim() ||
    !region.trim() ||
    !accessKeyId ||
    !secretAccessKey;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add S3 bucket</DialogTitle>
          <DialogDescription>
            Credentials are encrypted at rest and never returned over the API.
            For Cloudflare R2, Google Cloud Storage, or MinIO, set a custom
            endpoint.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="file-config-name">Name</Label>
            <Input
              id="file-config-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="production-uploads"
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">
              Letters, digits, underscore, dot, hyphen. Unique within the
              organization.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="file-config-bucket">Bucket</Label>
              <Input
                id="file-config-bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="my-bucket"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="file-config-region">Region</Label>
              <Input
                id="file-config-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-east-1"
                autoComplete="off"
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-endpoint">Endpoint (optional)</Label>
            <Input
              id="file-config-endpoint"
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://<account>.r2.cloudflarestorage.com"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Required for non-AWS providers (R2, GCS, MinIO).
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3">
            <div className="min-w-0">
              <Label htmlFor="file-config-path-style" className="text-sm">
                Force path-style URLs
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Required for Google Cloud Storage and most MinIO setups.
              </p>
            </div>
            <Switch
              id="file-config-path-style"
              checked={forcePathStyle}
              onCheckedChange={setForcePathStyle}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-prefix">Key prefix (optional)</Label>
            <Input
              id="file-config-prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="tenants/acme/"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              All object keys are written under this prefix. Useful for
              multi-tenant buckets or credentials scoped to a sub-path. A
              trailing slash is added automatically.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-public-url-base">
              Public URL base (optional)
            </Label>
            <Input
              id="file-config-public-url-base"
              type="url"
              value={publicUrlBase}
              onChange={(e) => setPublicUrlBase(e.target.value)}
              placeholder="https://pub-xxxx.r2.dev or https://cdn.example.com"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Host used to build public URLs returned by the picker (R2 dev
              domain, CDN, custom host). Leave blank to use the bucket's S3 host
              (AWS default).
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-access-key">Access key ID</Label>
            <Input
              id="file-config-access-key"
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value)}
              autoComplete="off"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-secret-key">Secret access key</Label>
            <Input
              id="file-config-secret-key"
              type="password"
              value={secretAccessKey}
              onChange={(e) => setSecretAccessKey(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="file-config-description">
              Description (optional)
            </Label>
            <Textarea
              id="file-config-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What is this bucket used for?"
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
              Cancel
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {createConfig.isPending ? "Adding…" : "Add bucket"}
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
  const deleteConfig = useDeleteFileConfig();

  async function handleConfirm() {
    if (!config) return;
    try {
      await deleteConfig.mutateAsync(config.id);
      toast.success(`Bucket "${config.name}" removed`);
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove bucket",
      );
    }
  }

  return (
    <AlertDialog open={config !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove bucket configuration?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the encrypted credentials for{" "}
            <span className="font-medium">{config?.name}</span>. The bucket
            itself is not affected. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteConfig.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={deleteConfig.isPending}
          >
            {deleteConfig.isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function FilesContent() {
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
          {configs.length} bucket{configs.length === 1 ? "" : "s"} configured
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus size={14} />
          Add bucket
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

export function OrgFilesPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Files</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load file configs")}
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
