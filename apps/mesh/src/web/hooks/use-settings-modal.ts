import { useNavigate, useParams, useSearch } from "@tanstack/react-router";

export type SettingsSection =
  | "account.profile"
  | "account.preferences"
  | "org.general"
  | "org.plugins"
  | "org.ai-providers"
  | "org.billing";

const VALID_SECTIONS = new Set<string>([
  "account.profile",
  "account.preferences",
  "org.general",
  "org.plugins",
  "org.ai-providers",
  "org.billing",
]);

function isValidSettingsSection(
  value: string | undefined,
): value is SettingsSection {
  if (!value) return false;
  return VALID_SECTIONS.has(value);
}

export function useSettingsModal() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { settings?: string };
  const { org, project } = useParams({ strict: false }) as {
    org?: string;
    project?: string;
  };

  const activeSection = isValidSettingsSection(search.settings)
    ? search.settings
    : undefined;
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
