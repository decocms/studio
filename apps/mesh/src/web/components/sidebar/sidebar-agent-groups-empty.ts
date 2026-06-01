import { useSyncExternalStore } from "react";

let empty = false;
const listeners = new Set<() => void>();

export function setSidebarAgentGroupsEmpty(next: boolean): void {
  if (empty === next) return;
  empty = next;
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): boolean {
  return empty;
}

export function useSidebarAgentGroupsEmpty(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
