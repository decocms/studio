/** Name a new project folder, or rename one. The caller applies the result. */

import { useState } from "react";
import { PROJECT_FOLDER_NAME_MAX } from "@decocms/shared/project-sidebar";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useT } from "@/i18n/use-t.ts";

export type FolderNameRequest =
  /** `projectId`: move this project into the folder once it exists. */
  | { kind: "create"; projectId?: string }
  | { kind: "rename"; folderId: string; name: string };

export function FolderNameDialog({
  request,
  onClose,
  onSave,
}: {
  request: FolderNameRequest | null;
  onClose: () => void;
  onSave: (request: FolderNameRequest, name: string) => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed so a reopen starts from the request's own name. */}
      {request && (
        <FolderNameForm
          key={request.kind === "rename" ? request.folderId : "create"}
          request={request}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </Dialog>
  );
}

function FolderNameForm({
  request,
  onClose,
  onSave,
}: {
  request: FolderNameRequest;
  onClose: () => void;
  onSave: (request: FolderNameRequest, name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(
    request.kind === "rename" ? request.name : "",
  );
  const trimmed = name.trim();

  return (
    <DialogContent className="sm:max-w-sm">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed) return;
          onSave(request, trimmed);
          onClose();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              request.kind === "rename"
                ? "sidebar.projects.renameFolder"
                : "sidebar.projects.newFolder",
            )}
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          maxLength={PROJECT_FOLDER_NAME_MAX}
          placeholder={t("sidebar.projects.folderName")}
          aria-label={t("sidebar.projects.folderName")}
          onChange={(event) => setName(event.target.value)}
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("sidebar.projects.folderCancel")}
          </Button>
          <Button type="submit" disabled={!trimmed}>
            {t("sidebar.projects.folderSave")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
