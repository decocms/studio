/**
 * Preset Task Store
 *
 * Typed wrapper over `KVStorage` for preset task state. Each task is stored
 * under its own key (`preset-tasks:<taskId>`) so concurrent writes to
 * different tasks never touch the same row. Concurrent writes to the same
 * task are last-write-wins — acceptable for dismiss/progress updates.
 */

import type { PresetTaskState } from "@decocms/mesh-sdk";
import { kvGet, kvSet, type KVStorage } from "./kv";

export type { PresetTaskState, PresetTaskStatus } from "@decocms/mesh-sdk";

const kvKey = (taskId: string) => `preset-tasks:${taskId}`;

export class PresetTaskStore {
  constructor(private kv: KVStorage) {}

  get(
    organizationId: string,
    taskId: string,
  ): Promise<PresetTaskState | undefined> {
    return kvGet<PresetTaskState | undefined>(
      this.kv,
      organizationId,
      kvKey(taskId),
      undefined,
    );
  }

  set(
    organizationId: string,
    taskId: string,
    state: PresetTaskState,
  ): Promise<void> {
    return kvSet(this.kv, organizationId, kvKey(taskId), state);
  }
}
