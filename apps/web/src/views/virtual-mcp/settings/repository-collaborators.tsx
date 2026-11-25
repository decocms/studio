/**
 * Project repository access, for org owners and admins: managed here for hosted
 * repositories (up to write), linked to GitHub for everyone else's.
 */

import { useState } from "react";
import { LinkExternal01, Plus, Trash01 } from "@untitledui/icons";
import { toast } from "sonner";
import { hasAdminRole } from "@decocms/shared/auth/roles";
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
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useCapabilities } from "@/hooks/use-capability";
import {
  type CollaboratorPermission,
  type GrantablePermission,
  useAddCollaborator,
  useRemoveCollaborator,
  useRepositoryAccessMode,
  useRepositoryCollaborators,
} from "@/hooks/use-git-providers";
import { useT } from "@/i18n/use-t.ts";

/** What Studio may grant; the API refuses more. */
const GRANTABLE: GrantablePermission[] = ["read", "triage", "write"];

/** Access Studio leaves alone, matching the API: the host's own people. */
function isHostAccess(permission: CollaboratorPermission | null): boolean {
  return (
    permission === null || permission === "maintain" || permission === "admin"
  );
}

function usePermissionLabel() {
  const t = useT();
  return (permission: CollaboratorPermission | null) => {
    switch (permission) {
      case "read":
        return t(
          "virtualMcp.settings.repository.collaborators.permission.read",
        );
      case "triage":
        return t(
          "virtualMcp.settings.repository.collaborators.permission.triage",
        );
      case "write":
        return t(
          "virtualMcp.settings.repository.collaborators.permission.write",
        );
      case "maintain":
        return t(
          "virtualMcp.settings.repository.collaborators.permission.maintain",
        );
      case "admin":
        return t(
          "virtualMcp.settings.repository.collaborators.permission.admin",
        );
      case null:
        return t(
          "virtualMcp.settings.repository.collaborators.permission.custom",
        );
    }
  };
}

export function RepositoryCollaboratorsSection({
  repositoryId,
}: {
  repositoryId: string;
}) {
  const { roleSlug } = useCapabilities();
  const isAdmin = hasAdminRole(roleSlug);
  const access = useRepositoryAccessMode(repositoryId, { enabled: isAdmin });
  if (!isAdmin || !access.data) return null;
  return access.data.mode === "managed" ? (
    <ManagedCollaborators repositoryId={repositoryId} />
  ) : (
    <SelfManagedAccess manageUrl={access.data.manageUrl} />
  );
}

function SelfManagedAccess({ manageUrl }: { manageUrl: string }) {
  const t = useT();
  return (
    <SettingsSection
      title={t("virtualMcp.settings.repository.collaborators.title")}
    >
      <SettingsCard>
        <SettingsCardItem
          title={t("virtualMcp.settings.repository.collaborators.selfTitle")}
          description={t(
            "virtualMcp.settings.repository.collaborators.selfDescription",
          )}
          action={
            <Button size="sm" variant="outline" asChild>
              <a href={manageUrl} target="_blank" rel="noopener noreferrer">
                {t(
                  "virtualMcp.settings.repository.collaborators.manageOnGithub",
                )}
                <LinkExternal01 size={14} />
              </a>
            </Button>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ManagedCollaborators({ repositoryId }: { repositoryId: string }) {
  const t = useT();
  const list = useRepositoryCollaborators(repositoryId);
  const remove = useRemoveCollaborator(repositoryId);
  const permissionLabel = usePermissionLabel();
  const [adding, setAdding] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<{
    login: string;
    invitation: boolean;
  } | null>(null);

  const people = [
    ...(list.data?.invitations ?? []).map((person) => ({
      ...person,
      invitation: true,
    })),
    ...(list.data?.collaborators ?? []).map((person) => ({
      ...person,
      invitation: false,
    })),
  ];

  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    const { login, invitation } = pendingRemoval;
    setPendingRemoval(null);
    remove.mutate(login, {
      onSuccess: () =>
        toast.success(
          invitation
            ? t("virtualMcp.settings.repository.collaborators.cancelled", {
                login,
              })
            : t("virtualMcp.settings.repository.collaborators.removed", {
                login,
              }),
        ),
      onError: (error) => toast.error(error.message),
    });
  };

  return (
    <SettingsSection
      title={t("virtualMcp.settings.repository.collaborators.title")}
      description={t(
        "virtualMcp.settings.repository.collaborators.description",
      )}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={list.isError}
          onClick={() => setAdding(true)}
        >
          <Plus size={14} />
          {t("virtualMcp.settings.repository.collaborators.add")}
        </Button>
      }
    >
      <SettingsCard>
        {list.isPending && (
          <SettingsCardItem
            title={t("virtualMcp.settings.repository.collaborators.loading")}
          />
        )}
        {list.isError && (
          <SettingsCardItem
            title={t("virtualMcp.settings.repository.collaborators.loadFailed")}
            description={list.error.message}
          />
        )}
        {list.isSuccess && people.length === 0 && (
          <SettingsCardItem
            title={t("virtualMcp.settings.repository.collaborators.empty")}
          />
        )}
        {people.map((person) => (
          <SettingsCardItem
            key={`${person.invitation ? "invitation" : "collaborator"}:${person.login}`}
            icon={
              <Avatar
                shape="circle"
                size="sm"
                url={person.avatarUrl ?? undefined}
                fallback={person.login}
              />
            }
            title={person.login}
            description={permissionLabel(person.permission)}
            action={
              <div className="flex items-center gap-2">
                {person.invitation && (
                  <Badge variant="warning">
                    {t("virtualMcp.settings.repository.collaborators.pending")}
                  </Badge>
                )}
                {isHostAccess(person.permission) ? (
                  <Badge>
                    {t(
                      "virtualMcp.settings.repository.collaborators.hostAccess",
                    )}
                  </Badge>
                ) : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={
                      person.invitation
                        ? t(
                            "virtualMcp.settings.repository.collaborators.cancelInvitation",
                          )
                        : t(
                            "virtualMcp.settings.repository.collaborators.remove",
                          )
                    }
                    disabled={remove.isPending}
                    onClick={() =>
                      setPendingRemoval({
                        login: person.login,
                        invitation: person.invitation,
                      })
                    }
                  >
                    <Trash01 size={14} />
                  </Button>
                )}
              </div>
            }
          />
        ))}
      </SettingsCard>

      <AddCollaboratorDialog
        repositoryId={repositoryId}
        open={adding}
        onOpenChange={setAdding}
      />

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemoval?.invitation
                ? t(
                    "virtualMcp.settings.repository.collaborators.cancelInvitationTitle",
                    { login: pendingRemoval.login },
                  )
                : t(
                    "virtualMcp.settings.repository.collaborators.removeTitle",
                    {
                      login: pendingRemoval?.login ?? "",
                    },
                  )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "virtualMcp.settings.repository.collaborators.removeDescription",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("virtualMcp.settings.repository.collaborators.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoval}>
              {pendingRemoval?.invitation
                ? t(
                    "virtualMcp.settings.repository.collaborators.cancelInvitation",
                  )
                : t("virtualMcp.settings.repository.collaborators.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function AddCollaboratorDialog({
  repositoryId,
  open,
  onOpenChange,
}: {
  repositoryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const add = useAddCollaborator(repositoryId);
  const permissionLabel = usePermissionLabel();
  const [username, setUsername] = useState("");
  const [permission, setPermission] = useState<GrantablePermission>("write");

  const close = () => {
    onOpenChange(false);
    setUsername("");
    setPermission("write");
  };

  const submit = () => {
    const login = username.trim();
    if (!login) return;
    add.mutate(
      { username: login, permission },
      {
        onSuccess: ({ status }) => {
          toast.success(
            status === "invited"
              ? t("virtualMcp.settings.repository.collaborators.invited", {
                  login,
                })
              : t("virtualMcp.settings.repository.collaborators.updated", {
                  login,
                }),
          );
          close();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("virtualMcp.settings.repository.collaborators.addTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("virtualMcp.settings.repository.collaborators.addDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="collaborator-username">
              {t("virtualMcp.settings.repository.collaborators.username")}
            </Label>
            <Input
              id="collaborator-username"
              autoComplete="off"
              autoFocus
              placeholder="octocat"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="collaborator-permission">
              {t(
                "virtualMcp.settings.repository.collaborators.permissionLabel",
              )}
            </Label>
            <Select
              value={permission}
              onValueChange={(value) => {
                const next = GRANTABLE.find((p) => p === value);
                if (next) setPermission(next);
              }}
            >
              <SelectTrigger id="collaborator-permission" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GRANTABLE.map((option) => (
                  <SelectItem key={option} value={option}>
                    {permissionLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("virtualMcp.settings.repository.collaborators.cancel")}
            </Button>
            <Button type="submit" disabled={!username.trim() || add.isPending}>
              {t("virtualMcp.settings.repository.collaborators.send")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
