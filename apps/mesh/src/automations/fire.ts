import type {
  DispatchRunInput,
  DispatchRunDeps,
} from "@/api/routes/decopilot/dispatch-run";
import type { MeshContext } from "@/core/mesh-context";
import { Cron } from "croner";

export type DispatchRunFn = (
  input: DispatchRunInput,
  ctx: MeshContext,
  deps: DispatchRunDeps,
) => Promise<{ taskId: string }>;

export type MeshContextFactory = (
  orgId: string,
  userId: string,
) => Promise<MeshContext | null>;

export function computeNextRunAt(
  cronExpression: string,
  after: Date,
): Date | null {
  try {
    return new Cron(cronExpression, { timezone: "UTC" }).nextRun(after) ?? null;
  } catch {
    return null;
  }
}
