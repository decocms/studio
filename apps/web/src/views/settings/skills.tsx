/**
 * Settings → Skills — the skills the org's agents can load.
 *
 * Skills already exist (org-fs `SKILL.md` folders, surfaced in the Library and
 * loadable by the `skill` tool) but there was nowhere to see which ones an org
 * has, so nobody knew the setting existed. This is that page: the catalog the
 * server resolves, with a route into the Library to add or edit one, and
 * Synced repos alongside for keeping them current from a repo.
 */

import { Link } from "@tanstack/react-router";
import { Lightbulb02, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import {
  fetchOrgFsSkillCatalog,
  type OrgFsSkillCatalogEntry,
} from "@/hooks/use-org-fs";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";

export function OrgSkillsPage() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: skills, isPending } = useQuery({
    queryKey: KEYS.slashSkills(org.id),
    queryFn: () => fetchOrgFsSkillCatalog(org.slug),
  });

  return (
    <SettingsGroupPage group="skills">
      <SettingsSection
        title={t("settings.skills.title")}
        description={t("settings.skills.description")}
        actions={
          <Button size="sm" asChild>
            <Link
              to="/$org"
              params={{ org: org.slug }}
              search={{ main: "files" }}
            >
              <Plus size={16} />
              {t("settings.skills.add")}
            </Link>
          </Button>
        }
      >
        {isPending ? (
          <SettingsCard>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </SettingsCard>
        ) : !skills || skills.length === 0 ? (
          <SettingsCard>
            <SettingsCardItem
              title={t("settings.skills.emptyTitle")}
              description={t("settings.skills.emptyDescription")}
            />
          </SettingsCard>
        ) : (
          <SettingsCard>
            {skills.map((skill) => (
              <SkillRow key={skill.id} skill={skill} orgSlug={org.slug} />
            ))}
          </SettingsCard>
        )}
      </SettingsSection>
    </SettingsGroupPage>
  );
}

function SkillRow({
  skill,
  orgSlug,
}: {
  skill: OrgFsSkillCatalogEntry;
  orgSlug: string;
}) {
  const t = useT();
  return (
    <SettingsCardItem
      icon={
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Lightbulb02 size={16} />
        </div>
      }
      title={skill.name}
      description={skill.description ?? skill.path}
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link
            to="/$org"
            params={{ org: orgSlug }}
            search={{ main: "files" }}
            title={`${skill.volume}/${skill.path}`}
          >
            {t("settings.skills.viewInLibrary")}
          </Link>
        </Button>
      }
    />
  );
}
