import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

export function useGitPanel() {
  const [open, setOpen] = useLocalStorage<boolean>(
    LOCALSTORAGE_KEYS.gitPanelOpen(),
    false,
  );

  return [open, setOpen] as const;
}
