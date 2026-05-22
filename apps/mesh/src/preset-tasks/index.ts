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

import type {
  PresetTaskAction,
  PresetTaskDisplay,
  PresetTaskState,
  VisiblePresetTask,
} from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import type { ChatMessage } from "@/api/routes/decopilot/types";
import type { PresetTaskStore } from "@/storage/preset-tasks";

export type {
  PresetTaskAction,
  PresetTaskDisplay,
  VisiblePresetTask,
} from "@decocms/mesh-sdk";

export interface PresetTaskContext {
  organizationId: string;
}

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
   * Returns true when this task makes sense for the given org. For tasks
   * that morph between faces based on world state (e.g. brand-context
   * becoming "Confirm your brand") leave this `true` and use `resolve()`
   * to swap presentation — `isApplicable` answers "should this card
   * exist at all", `resolve()` answers "what does this card look like
   * right now".
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
  /**
   * Optional. Returns overrides for `display` / `action` / `start` based
   * on current state + world. Use when one logical task has multiple
   * presentations — e.g. brand-context showing "Set up your brand" with
   * the setup seed when no brand exists, and "Confirm your brand" with a
   * confirm seed once one does. The agent id usually stays the same
   * across faces; the agent derives its own mode from the same state.
   */
  resolve?: (
    ctx: PresetTaskContext,
    state: PresetTaskState | undefined,
    mesh: MeshContext,
  ) => Promise<
    Partial<Pick<PresetTaskDefinition, "display" | "action" | "start">>
  >;
}

/**
 * Apply a definition's `resolve()` (if any) and return the effective
 * shape callers should use. `getVisiblePresetTasks` and the `/start`
 * route both go through this so they project the same face.
 */
export async function resolveDefinition(
  def: PresetTaskDefinition,
  ctx: PresetTaskContext,
  state: PresetTaskState | undefined,
  mesh: MeshContext,
): Promise<PresetTaskDefinition> {
  if (!def.resolve) return def;
  const overrides = await def.resolve(ctx, state, mesh);
  return {
    ...def,
    display: overrides.display ?? def.display,
    action: overrides.action ?? def.action,
    start: overrides.start ?? def.start,
  };
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
    // Completed tasks stay in the list so the FE can render the
    // "Done" treatment on both the preset card and any pinned tile.
    // Per-preset `isApplicable` only gates the *new* / unfinished state.
    const isCompleted = state?.status === "completed";
    if (isCompleted || (await def.isApplicable(ctx, state, mesh))) {
      const resolved = await resolveDefinition(def, ctx, state, mesh);
      visible.push({
        id: resolved.id,
        display: resolved.display,
        action: resolved.action,
        state,
        dismissible: resolved.dismissible !== false,
      });
    }
  }
  return visible;
}
