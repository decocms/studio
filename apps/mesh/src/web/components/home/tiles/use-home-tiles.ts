/**
 * Persists which preset tiles the user has activated, per org. A tile
 * is activated when the user starts its preset task from the side
 * panel; it then renders below the chat on the home page.
 */

import { useSyncExternalStore } from "react";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import type { TileId, TileState } from "./types";

interface StoredTile {
  id: TileId;
  taskId: string;
  status: "running" | "ready";
  updatedAt: string;
}

function readAll(orgSlug: string): StoredTile[] {
  try {
    const raw = localStorage.getItem(LOCALSTORAGE_KEYS.homeTiles(orgSlug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredTile[]) : [];
  } catch {
    return [];
  }
}

function writeAll(orgSlug: string, tiles: StoredTile[]) {
  localStorage.setItem(
    LOCALSTORAGE_KEYS.homeTiles(orgSlug),
    JSON.stringify(tiles),
  );
  window.dispatchEvent(new Event("home-tiles:changed"));
}

function subscribe(callback: () => void) {
  const handler = () => callback();
  window.addEventListener("home-tiles:changed", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("home-tiles:changed", handler);
    window.removeEventListener("storage", handler);
  };
}

export function useHomeTiles(orgSlug: string) {
  const tiles = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(LOCALSTORAGE_KEYS.homeTiles(orgSlug)) ?? "",
    () => "",
  );

  const parsed: TileState[] = (() => {
    try {
      const arr = tiles ? (JSON.parse(tiles) as StoredTile[]) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  })();

  const activate = (id: TileId, taskId: string) => {
    const current = readAll(orgSlug);
    const without = current.filter((t) => t.id !== id);
    const next: StoredTile = {
      id,
      taskId,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    writeAll(orgSlug, [...without, next]);
  };

  return { tiles: parsed, activate };
}
