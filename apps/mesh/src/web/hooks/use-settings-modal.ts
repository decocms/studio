import { useNavigate, useParams, useSearch } from "@tanstack/react-router";

export type SettingsSection =
  | "account.profile"
  | "account.preferences"
  | "account.experimental"
  | "org.general"
  | "project.general"
  | "project.plugins"
  | "project.danger";

export function useSettingsModal() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { settings?: string };
  const { org, project } = useParams({ strict: false }) as {
    org?: string;
    project?: string;
  };

  const activeSection = search.settings as SettingsSection | undefined;
  const isOpen = !!activeSection;

  const open = (section: SettingsSection) => {
    if (!org || !project) return;
    navigate({
      to: "/$org/$project",
      params: { org, project },
      search: { settings: section },
    });
  };

  const close = () => {
    if (!org || !project) return;
    navigate({
      to: "/$org/$project",
      params: { org, project },
      search: {},
    });
  };

  return {
    isOpen,
    activeSection: activeSection ?? ("account.preferences" as SettingsSection),
    open,
    close,
  };
}
