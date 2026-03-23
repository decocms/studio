import { useNavigate, useMatch, useSearch } from "@tanstack/react-router";

export type SettingsSection =
  | "account.profile"
  | "account.preferences"
  | "org.general"
  | "org.plugins"
  | "org.ai-providers"
  | "org.billing"
  | "org.members";

const VALID_SECTIONS = new Set<string>([
  "account.profile",
  "account.preferences",
  "org.general",
  "org.plugins",
  "org.ai-providers",
  "org.billing",
  "org.members",
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
  const orgMatch = useMatch({ from: "/shell/$org", shouldThrow: false });
  const org = orgMatch?.params.org;

  const activeSection = isValidSettingsSection(search.settings)
    ? search.settings
    : undefined;
  const isOpen = !!activeSection;

  const open = (section: SettingsSection) => {
    if (!org) return;
    navigate({
      to: "/$org",
      params: { org },
      search: { settings: section },
    });
  };

  const close = () => {
    if (!org) return;
    navigate({
      to: "/$org",
      params: { org },
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
