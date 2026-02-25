import { useNavigate, useSearch } from "@tanstack/react-router";

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

  const activeSection = search.settings as SettingsSection | undefined;
  const isOpen = !!activeSection;

  const open = (section: SettingsSection) => {
    navigate({ search: (prev) => ({ ...prev, settings: section }) });
  };

  const close = () => {
    navigate({
      search: (prev) => {
        const { settings: _s, ...rest } = prev as Record<string, unknown>;
        return rest as Record<string, string>;
      },
    });
  };

  return {
    isOpen,
    activeSection: activeSection ?? "account.preferences",
    open,
    close,
  };
}
