/**
 * The org's imported repositories, each with a switch that puts its pushes on
 * the Deploys tab.
 */

import { Switch } from "@decocms/ui/components/switch.tsx";
import { ListRow } from "@decocms/ui/components/list-row.tsx";
import { IntegrationIcon } from "@/components/integration-icon";
import {
  useRepositories,
  useUpdateRepository,
} from "@/hooks/use-git-providers";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { platformName } from "./sources-panel";
import { useSourceIcons } from "./use-source-icons";

export function MonitoredRepos() {
  const t = useT();
  const { org } = useProjectContext();
  const iconOf = useSourceIcons(org.slug, []);
  const repositories = useRepositories().data ?? [];
  const update = useUpdateRepository();
  return (
    <div className="flex max-h-72 flex-col overflow-y-auto">
      {repositories.map((repository) => (
        <ListRow
          key={repository.id}
          variant="divided"
          lead={
            <IntegrationIcon
              icon={iconOf("deploys")}
              name={platformName("deploys", t)}
              size="xs"
              fit="contain"
            />
          }
          title={repository.path}
          meta={repository.defaultBranch ?? undefined}
          trailing={
            <Switch
              aria-label={t("monitor.repos.toggle", { repo: repository.path })}
              checked={repository.monitorDeploys}
              disabled={update.isPending}
              onCheckedChange={(monitorDeploys) =>
                update.mutate({ id: repository.id, monitorDeploys })
              }
            />
          }
        />
      ))}
    </div>
  );
}
