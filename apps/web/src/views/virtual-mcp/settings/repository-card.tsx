/**
 * The project's repository, connected or changed in place: the picker binds it
 * the same way importing a repository does (`metadata.repository` with its
 * `repositoryId`), so the project needs no detour through Connections.
 */

import { useState } from "react";
import type { RepositoryBinding } from "@decocms/shared/sdk/types";
import { Button } from "@decocms/ui/components/button.tsx";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  RepositoryPicker,
  type RepositoryPickPayload,
} from "@/components/repository-picker";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { toast } from "sonner";

/** A picked repository as the binding a project stores. */
function bindingOf({ repository }: RepositoryPickPayload): RepositoryBinding {
  const segments = repository.path.split("/");
  return {
    owner: segments.slice(0, -1).join("/"),
    name: segments.at(-1) ?? repository.path,
    url: repository.webUrl,
    repositoryId: repository.id,
  };
}

export function RepositoryCard({
  repo,
  onConnect,
}: {
  repo: { owner: string; name: string; url: string } | null;
  onConnect: (binding: RepositoryBinding) => Promise<void> | void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  return (
    <SettingsSection>
      <SettingsCard>
        <SettingsCardItem
          icon={<GitHubIcon size={20} className="text-foreground/70" />}
          title={
            repo
              ? `${repo.owner}/${repo.name}`
              : t("virtualMcp.settings.repository.none")
          }
          description={
            repo
              ? repo.url
              : t("virtualMcp.settings.repository.noneDescription")
          }
          action={
            <Button
              size="sm"
              variant={repo ? "outline" : "default"}
              onClick={() => setPicking(true)}
            >
              {repo
                ? t("virtualMcp.settings.repository.change")
                : t("virtualMcp.settings.repository.connect")}
            </Button>
          }
        />
      </SettingsCard>
      <RepositoryPicker
        open={picking}
        onOpenChange={setPicking}
        title={t("virtualMcp.settings.repository.connect")}
        onPicked={async (payload) => {
          await onConnect(bindingOf(payload));
          setPicking(false);
          toast.success(
            t("virtualMcp.settings.repository.connected", {
              name: payload.repository.path,
            }),
          );
        }}
        onError={(message) => toast.error(message)}
      />
    </SettingsSection>
  );
}
