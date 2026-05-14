/**
 * Kick off a preset task from the home — creates a new task id, primes
 * the autosend cache with the prompt, optionally pins the matching tile
 * to the home board (carrying the new task id so the tile can link back
 * into the chat), then navigates to the new thread.
 */

import {
  getWellKnownDecopilotVirtualMCP,
  type ProjectLocator,
} from "@decocms/mesh-sdk";
import type { useNavigate } from "@tanstack/react-router";
import { AUTOSEND_QUERY_VALUE, writeStoredAutosend } from "@/web/lib/autosend";
import type { PresetTileType } from "./registry";
import { PRESET_DEFAULT_SIZE } from "./registry";
import { SIZE_PRESETS } from "./constants";
import type { TileInstance } from "./types";

function buildDoc(prompt: string) {
  return {
    type: "doc" as const,
    content: [
      {
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: prompt }],
      },
    ],
  };
}

function newId(): string {
  return `tile_${Math.random().toString(36).slice(2, 10)}`;
}

interface StartArgs {
  prompt: string;
  orgId: string;
  orgSlug: string;
  locator: ProjectLocator;
  navigate: ReturnType<typeof useNavigate>;
  /** When provided, the matching home tile is pinned to the user's board. */
  tileType?: PresetTileType;
  addTile?: (tile: Omit<TileInstance, "x" | "y">) => void;
}

export function startPresetTask({
  prompt,
  orgId,
  orgSlug,
  locator,
  navigate,
  tileType,
  addTile,
}: StartArgs) {
  const taskId = crypto.randomUUID();
  const targetVmcp = getWellKnownDecopilotVirtualMCP(orgId).id;
  writeStoredAutosend(sessionStorage, locator, taskId, {
    tiptapDoc: buildDoc(prompt),
  });
  if (tileType && addTile) {
    const size = SIZE_PRESETS[PRESET_DEFAULT_SIZE];
    addTile({
      id: newId(),
      type: tileType,
      w: size.w,
      h: size.h,
      config: { taskId, status: "running" },
    });
  }
  navigate({
    to: "/$org/$taskId",
    params: { org: orgSlug, taskId },
    search: { virtualmcpid: targetVmcp, autosend: AUTOSEND_QUERY_VALUE },
  });
}
