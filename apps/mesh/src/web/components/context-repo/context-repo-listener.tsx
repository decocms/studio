/**
 * Context Repo Modal Listener
 *
 * Listens for the "open-context-repo-modal" custom event (dispatched from sidebar)
 * and manages the modal open state. Mounted in the project layout.
 */

import { useRef, useState } from "react";
import { ContextRepoModal } from "./context-repo-modal";

export function ContextRepoModalListener() {
  const [open, setOpen] = useState(false);
  const registeredRef = useRef(false);

  // Register event listener once
  if (!registeredRef.current && typeof window !== "undefined") {
    registeredRef.current = true;
    window.addEventListener("open-context-repo-modal", () => {
      setOpen(true);
    });
  }

  return <ContextRepoModal open={open} onOpenChange={setOpen} />;
}
