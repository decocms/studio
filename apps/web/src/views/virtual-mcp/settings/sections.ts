/** Project settings tabs. Existing `?section=` links keep their destinations. */

import type { TranslationKey } from "@/i18n/use-t.ts";
import { Database01, LayoutAlt04, Link01, Settings01 } from "@untitledui/icons";
import type { ComponentType, SVGProps } from "react";

export const PROJECT_SETTINGS_SECTION_KEYS = [
  "general",
  "connections",
  "site",
  "views",
] as const;

export type ProjectSettingsSectionKey =
  (typeof PROJECT_SETTINGS_SECTION_KEYS)[number];

export interface ProjectSettingsSectionDef {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  titleKey: TranslationKey;
  headingKey: TranslationKey;
  descriptionKey: TranslationKey;
}

export const PROJECT_SETTINGS_SECTIONS: Record<
  ProjectSettingsSectionKey,
  ProjectSettingsSectionDef
> = {
  general: {
    icon: Settings01,
    titleKey: "virtualMcp.settings.general.title",
    headingKey: "virtualMcp.settings.general.heading",
    descriptionKey: "virtualMcp.settings.general.description",
  },
  connections: {
    icon: Link01,
    titleKey: "virtualMcp.settings.connections.title",
    headingKey: "virtualMcp.settings.connections.heading",
    descriptionKey: "virtualMcp.settings.connections.description",
  },
  site: {
    icon: Database01,
    titleKey: "virtualMcp.settings.site.title",
    headingKey: "virtualMcp.settings.site.heading",
    descriptionKey: "virtualMcp.settings.site.description",
  },
  views: {
    icon: LayoutAlt04,
    titleKey: "virtualMcp.settings.views.projectViews",
    headingKey: "virtualMcp.settings.views.projectViews",
    descriptionKey: "virtualMcp.settings.views.description",
  },
};

export function isProjectSettingsSectionKey(
  value: string | undefined | null,
): value is ProjectSettingsSectionKey {
  return (
    !!value &&
    (PROJECT_SETTINGS_SECTION_KEYS as readonly string[]).includes(value)
  );
}
