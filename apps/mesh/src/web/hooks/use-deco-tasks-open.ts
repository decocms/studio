import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

export function useDecoTasksOpen() {
  const [open, setOpenStorage] = useLocalStorage<boolean>(
    LOCALSTORAGE_KEYS.decoTasksOpen(),
    (existing) => Boolean(existing ?? false),
  );

  return [open, setOpenStorage] as const;
}
