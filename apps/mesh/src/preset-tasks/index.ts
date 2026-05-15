/**
 * Preset Task Registry
 *
 * Owns the full card contract: what shows in the tasks panel (`display`),
 * what happens on click (`action`), whether the card is applicable to this
 * org (`isApplicable`), and — for `kind: "preset"` cards — how to compose
 * the seed messages that kick the agent stream (`start`).
 *
 * The FE only renders what GET /preset-tasks returns; click for a `preset`
 * card POSTs to /preset-tasks/:id/start and navigates to the returned task.
 * `new-chat` and `import-deco` are pure-FE actions — listed here so the BE
 * stays the single source of card visibility, but no `start` is invoked.
 *
 * Definitions are registered at boot today; the surface stays runtime-
 * mutable so later we can hydrate from a `preset_task_definitions` table
 * without touching call sites.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import type { PresetTaskState, PresetTaskStore } from "@/storage/preset-tasks";

export interface PresetTaskContext {
  organizationId: string;
}

/**
 * Closed union of tile types the FE knows how to render. Mirrors
 * `PresetTileType` in `apps/mesh/src/web/components/home/tiles/registry.tsx`.
 * The BE returns these strings; the FE pins the matching tile.
 */
export type PresetTileType =
  | "studio.brand-context"
  | "studio.landing-page"
  | "studio.error-monitoring";

export interface PresetTaskDisplay {
  title: string;
  /** Public-asset path under `apps/mesh/public/` (e.g. `/home/task-brand.svg`). */
  thumb: string;
  /** 1/2/3 for the brand → site → monitoring guided flow; null otherwise. */
  step: number | null;
}

export type PresetTaskAction =
  | { kind: "new-chat" }
  | { kind: "import-deco" }
  | { kind: "preset"; tileType: PresetTileType };

export interface PresetTaskStartResult {
  /** Seed messages for the new thread. Usually one user message. */
  messages: ChatMessage[];
  /** Which virtualMCP to run against. */
  virtualMcpId: string;
}

export interface PresetTaskDefinition {
  id: string;
  display: PresetTaskDisplay;
  action: PresetTaskAction;
  /**
   * Returns true when this task makes sense for the given org. Async so
   * predicates can fan out to other storage (e.g. "show error-monitoring
   * once any error has been captured for this org", or "hide brand-context
   * once the org has any brand_context row").
   */
  isApplicable: (
    ctx: PresetTaskContext,
    state: PresetTaskState | undefined,
    mesh: MeshContext,
  ) => boolean | Promise<boolean>;
  /**
   * Whether the user can dismiss this card. Defaults to true. Set false for
   * essential always-present actions (e.g. "New chat") that would leave a
   * gap in the panel if removed.
   */
  dismissible?: boolean;
  /**
   * Required iff `action.kind === "preset"`. Composes the seed messages +
   * which vmcp the run uses. Async so cards can fetch user info, brand
   * data, etc. before deciding what to send.
   */
  start?: (
    ctx: PresetTaskContext,
    mesh: MeshContext,
  ) => Promise<PresetTaskStartResult>;
}

export class PresetTaskRegistry {
  private definitions = new Map<string, PresetTaskDefinition>();

  register(definition: PresetTaskDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  get(id: string): PresetTaskDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): PresetTaskDefinition[] {
    return Array.from(this.definitions.values());
  }
}

export interface VisiblePresetTask {
  id: string;
  display: PresetTaskDisplay;
  action: PresetTaskAction;
  state: PresetTaskState | undefined;
  dismissible: boolean;
}

/**
 * Filters registered preset tasks through their `isApplicable` predicate
 * against the org's stored state. Used by the FE endpoint that decides
 * which cards to render.
 */
export async function getVisiblePresetTasks(
  organizationId: string,
  store: PresetTaskStore,
  registry: PresetTaskRegistry,
  mesh: MeshContext,
): Promise<VisiblePresetTask[]> {
  const ctx: PresetTaskContext = { organizationId };
  const defs = registry.list();
  const entries = await Promise.all(
    defs.map(async (def) => ({
      def,
      state: await store.get(organizationId, def.id),
    })),
  );
  const visible: VisiblePresetTask[] = [];
  for (const { def, state } of entries) {
    if (await def.isApplicable(ctx, state, mesh)) {
      visible.push({
        id: def.id,
        display: def.display,
        action: def.action,
        state,
        dismissible: def.dismissible !== false,
      });
    }
  }
  return visible;
}
