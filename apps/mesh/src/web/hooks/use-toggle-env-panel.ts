import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * Focus the Env tab via the `?main=<tabId>` URL contract shared with
 * useChatMainPanelState. toggleEnv collapses back to `?main=0` when already active.
 */
const ENV_TAB_ID = "env";

export function useToggleEnvPanel() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { main?: string };
  const envOpen = search.main === ENV_TAB_ID;

  const setMain = (value: string) => {
    navigate({
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        main: value,
      })) as any,
      replace: true,
    });
  };

  const toggleEnv = () => {
    setMain(envOpen ? "0" : ENV_TAB_ID);
  };

  const openEnv = () => {
    if (envOpen) return;
    setMain(ENV_TAB_ID);
  };

  return { envOpen, toggleEnv, openEnv };
}
