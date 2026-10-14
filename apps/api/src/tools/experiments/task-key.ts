/**
 * Resolve the human address (`DECO-07`) of the task board card implementing an
 * experiment, so the Experiments screen can deep-link to the card's chat.
 *
 * The experiment row stores the card's id, not its key: the key is derived from
 * the org slug plus the card's per-org sequence, and the slug can change. The
 * id is the stable fact; the address is computed on read, here, once.
 */

import type { StudioContext } from "../../core/studio-context";
import type { Experiment } from "../../storage/types";
import { taskKey } from "@decocms/shared/task-key";

/** The experiment as the tools return it: storage row plus the resolved key. */
export type ExperimentWithTaskKey = Experiment & { taskKey: string | null };

/**
 * Attach `taskKey` to each experiment. Best-effort per card — a deleted card
 * (or a read that fails) yields a null key rather than failing the whole list,
 * because `taskBoardItemId` is still the honest answer about delegation and the
 * screen degrades to "no chat link".
 */
export async function withTaskKeys(
  ctx: StudioContext,
  organizationId: string,
  organizationSlug: string | null | undefined,
  experiments: Experiment[],
): Promise<ExperimentWithTaskKey[]> {
  return Promise.all(
    experiments.map(async (experiment) => {
      if (!experiment.taskBoardItemId || !organizationSlug) {
        return { ...experiment, taskKey: null };
      }
      const item = await ctx.storage.taskBoard
        .getById(experiment.taskBoardItemId, organizationId)
        .catch(() => null);
      return {
        ...experiment,
        taskKey:
          item?.keySeq != null ? taskKey(organizationSlug, item.keySeq) : null,
      };
    }),
  );
}

/** Single-experiment form of {@link withTaskKeys}. */
export async function withTaskKey(
  ctx: StudioContext,
  organizationId: string,
  organizationSlug: string | null | undefined,
  experiment: Experiment,
): Promise<ExperimentWithTaskKey> {
  const [withKey] = await withTaskKeys(ctx, organizationId, organizationSlug, [
    experiment,
  ]);
  return withKey!;
}
