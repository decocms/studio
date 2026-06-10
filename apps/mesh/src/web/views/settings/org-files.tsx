/**
 * Settings → Files: browser over the organization filesystem — the same
 * volumes sandboxes mount at `org/` (skills = shared library, outputs =
 * agent run outputs). Volumes render as root-level folders so the whole
 * thing reads as one filesystem; the first path segment is the volume.
 * Browse, upload, download, create folders, delete. Data layer in
 * @/web/hooks/use-org-fs (org-scoped HTTP, session auth).
 */

import { useRef, useState } from "react";
import {
  ChevronRight,
  Download01,
  File02,
  Folder,
  Lock01,
  Plus,
  RefreshCw01,
  Trash01,
  Upload01,
} from "@untitledui/icons";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
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
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Page } from "@/web/components/page";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { KEYS } from "@/web/lib/query-keys";
import {
  type OrgFsEntry,
  type OrgFsUsage,
  useOrgFsDownloadUrl,
  useOrgFsList,
  useOrgFsMutations,
  useOrgFsPublicSets,
  useOrgFsUsage,
} from "@/web/hooks/use-org-fs";

/** The volumes every sandbox mounts (see file-storage/mount/provisioning.ts). */
const VOLUMES = [
  { id: "skills", description: "Org-wide shared library" },
  { id: "outputs", description: "Agent run outputs, one folder per thread" },
] as const;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function Breadcrumbs(props: {
  segments: string[];
  onNavigate: (segments: string[]) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-sm min-w-0 flex-wrap">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground hover:underline"
        onClick={() => props.onNavigate([])}
      >
        org
      </button>
      {props.segments.map((seg, i) => {
        const isLast = i === props.segments.length - 1;
        return (
          <span
            key={props.segments.slice(0, i + 1).join("/")}
            className="flex items-center gap-1 min-w-0"
          >
            <ChevronRight
              size={12}
              className="text-muted-foreground shrink-0"
            />
            {isLast ? (
              <span className="font-medium truncate">{seg}</span>
            ) : (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground hover:underline truncate"
                onClick={() => props.onNavigate(props.segments.slice(0, i + 1))}
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function Row(props: {
  icon: React.ReactNode;
  name: React.ReactNode;
  size: string;
  modified: string;
  actions?: React.ReactNode;
  onOpen?: () => void;
}) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-muted/50">
      <td className="px-4 py-2">
        {props.onOpen ? (
          <button
            type="button"
            className="flex items-center gap-2 hover:underline"
            onClick={props.onOpen}
          >
            {props.icon}
            <span className="font-medium">{props.name}</span>
          </button>
        ) : (
          <span className="flex items-center gap-2">
            {props.icon}
            {props.name}
          </span>
        )}
      </td>
      <td className="px-4 py-2 text-muted-foreground">{props.size}</td>
      <td className="px-4 py-2 text-muted-foreground">{props.modified}</td>
      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-1">
          {props.actions}
        </div>
      </td>
    </tr>
  );
}

function ListFrame(props: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium w-28">Size</th>
            <th className="px-4 py-2 font-medium w-48">Modified</th>
            <th className="px-4 py-2 w-20" />
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

/** Root listing: each volume is a folder; usage doubles as its size. */
function VolumeRootRows(props: { onOpen: (segments: string[]) => void }) {
  const skills = useOrgFsUsage(VOLUMES[0].id);
  const outputs = useOrgFsUsage(VOLUMES[1].id);
  const publicSets = useOrgFsPublicSets();
  const usageFor: Record<string, OrgFsUsage | undefined> = {
    skills: skills.data,
    outputs: outputs.data,
  };
  return (
    <>
      {VOLUMES.map((v) => {
        const usage = usageFor[v.id];
        return (
          <Row
            key={v.id}
            icon={<Folder size={15} className="text-muted-foreground" />}
            name={
              <span className="flex items-baseline gap-2">
                {v.id}
                <span className="text-xs font-normal text-muted-foreground">
                  {v.description}
                </span>
              </span>
            }
            size={
              usage ? `${usage.files} files · ${formatBytes(usage.bytes)}` : "—"
            }
            modified=""
            onOpen={() => props.onOpen([v.id])}
          />
        );
      })}
      {(publicSets.data?.length ?? 0) > 0 && (
        <Row
          icon={<Lock01 size={15} className="text-muted-foreground" />}
          name={
            <span className="flex items-baseline gap-2">
              public
              <span className="text-xs font-normal text-muted-foreground">
                Curated skill sets — read-only, same for every org
              </span>
            </span>
          }
          size={`${publicSets.data?.length} sets`}
          modified=""
          onOpen={() => props.onOpen(["public"])}
        />
      )}
    </>
  );
}

/** Listing for `org/public`: one locked folder per configured set. */
function PublicSetsRows(props: { onOpen: (set: string) => void }) {
  const publicSets = useOrgFsPublicSets();
  return (
    <>
      {(publicSets.data ?? []).map((set) => (
        <Row
          key={set}
          icon={<Lock01 size={15} className="text-muted-foreground" />}
          name={set}
          size="—"
          modified=""
          onOpen={() => props.onOpen(set)}
        />
      ))}
    </>
  );
}

function VolumeListing(props: {
  volume: string;
  path: string;
  readOnly: boolean;
  onOpenDir: (path: string) => void;
  onDelete: (entry: OrgFsEntry) => void;
}) {
  const { volume, path } = props;
  const listing = useOrgFsList(volume, path);
  const downloadUrl = useOrgFsDownloadUrl(volume);

  if (listing.isLoading) {
    return (
      <tr>
        <td colSpan={4} className="p-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        </td>
      </tr>
    );
  }
  if (listing.isError) {
    return (
      <tr>
        <td colSpan={4} className="p-6 text-sm text-destructive">
          {listing.error instanceof Error
            ? listing.error.message
            : "Failed to load"}
        </td>
      </tr>
    );
  }
  const entries = listing.data ?? [];
  if (entries.length === 0) {
    return (
      <tr>
        <td
          colSpan={4}
          className="p-10 text-center text-sm text-muted-foreground"
        >
          Empty folder — upload a file or create a folder to get started.
        </td>
      </tr>
    );
  }
  return (
    <>
      {entries.map((entry) => {
        const name = basename(entry.path);
        const isDir = entry.kind === "dir";
        return (
          <Row
            key={entry.path}
            icon={
              isDir ? (
                <Folder size={15} className="text-muted-foreground" />
              ) : (
                <File02 size={15} className="text-muted-foreground" />
              )
            }
            name={name}
            size={isDir ? "—" : formatBytes(entry.size)}
            modified={formatDate(entry.updatedAt)}
            onOpen={isDir ? () => props.onOpenDir(entry.path) : undefined}
            actions={
              <>
                {!isDir && (
                  <Button variant="ghost" size="icon" asChild>
                    <a
                      href={downloadUrl(entry.path)}
                      download={name}
                      aria-label={`Download ${name}`}
                    >
                      <Download01 size={14} />
                    </a>
                  </Button>
                )}
                {!props.readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${name}`}
                    onClick={() => props.onDelete(entry)}
                  >
                    <Trash01 size={14} />
                  </Button>
                )}
              </>
            }
          />
        );
      })}
    </>
  );
}

function FsBrowser() {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  // First segment is the volume; [] is the synthetic root listing volumes.
  // The `public` namespace maps `public/<set>/...` → readonly volume
  // `public-<set>` (mirroring the sandbox's org/public/<set> mounts).
  const [segments, setSegments] = useState<string[]>([]);
  const isPublic = segments[0] === "public";
  const publicSet = isPublic ? (segments[1] ?? null) : null;
  const volume = isPublic
    ? publicSet
      ? `public-${publicSet}`
      : null
    : (segments[0] ?? null);
  const path = (isPublic ? segments.slice(2) : segments.slice(1)).join("/");
  const readOnly = isPublic;

  const [pendingDelete, setPendingDelete] = useState<OrgFsEntry | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { upload, mkdir, remove } = useOrgFsMutations(volume ?? VOLUMES[0].id);

  async function handleUpload(files: FileList | null) {
    if (!volume || !files || files.length === 0) return;
    try {
      await upload.mutateAsync({ dir: path, files: [...files] });
      toast.success(
        files.length === 1
          ? `Uploaded ${files[0]?.name}`
          : `Uploaded ${files.length} files`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!volume || !name) return;
    try {
      await mkdir.mutateAsync(path ? `${path}/${name}` : name);
      toast.success(`Folder "${name}" created`);
      setNewFolderOpen(false);
      setNewFolderName("");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create folder",
      );
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    try {
      await remove.mutateAsync(entry.path);
      toast.success(`Deleted ${basename(entry.path)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Breadcrumbs segments={segments} onNavigate={setSegments} />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              Promise.all(
                VOLUMES.map((v) =>
                  queryClient.invalidateQueries({
                    queryKey: KEYS.orgFsVolume(org.id, v.id),
                  }),
                ),
              )
            }
          >
            <RefreshCw01 size={14} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!volume || readOnly}
            onClick={() => setNewFolderOpen(true)}
          >
            <Plus size={14} />
            New folder
          </Button>
          <Button
            size="sm"
            disabled={!volume || readOnly || upload.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload01 size={14} />
            {upload.isPending ? "Uploading…" : "Upload"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleUpload(e.target.files)}
          />
        </div>
      </div>

      <ListFrame>
        {segments.length === 0 ? (
          <VolumeRootRows onOpen={setSegments} />
        ) : volume === null ? (
          <PublicSetsRows onOpen={(set) => setSegments(["public", set])} />
        ) : (
          <VolumeListing
            // remount on volume switch so list state never bleeds across
            key={volume}
            volume={volume}
            path={path}
            readOnly={readOnly}
            onOpenDir={(p) =>
              setSegments(
                isPublic && publicSet
                  ? ["public", publicSet, ...p.split("/")]
                  : [volume, ...p.split("/")],
              )
            }
            onDelete={setPendingDelete}
          />
        )}
      </ListFrame>

      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in {segments.length ? segments.join("/") : "org"}.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="folder-name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateFolder();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newFolderName.trim() || mkdir.isPending}
              onClick={() => void handleCreateFolder()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete ? basename(pendingDelete.path) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "dir"
                ? "The folder and everything inside it will be deleted for the whole organization. Sandboxes see this change within seconds."
                : "The file will be deleted for the whole organization. Sandboxes see this change within seconds."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function OrgFsFilesPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <div className="flex flex-col gap-1">
              <Page.Title>Files</Page.Title>
              <p className="text-sm text-muted-foreground">
                The organization filesystem — mounted at{" "}
                <code className="text-xs">org/</code> inside every sandbox.
              </p>
            </div>
            <ErrorBoundary>
              <FsBrowser />
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
