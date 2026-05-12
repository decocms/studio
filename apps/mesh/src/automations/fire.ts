import type {
  StreamCoreInput,
  StreamCoreDeps,
} from "@/api/routes/decopilot/stream-core";
import type { MeshContext } from "@/core/mesh-context";
import { Cron } from "croner";

export type StreamCoreFn = (
  input: StreamCoreInput,
  ctx: MeshContext,
  deps: StreamCoreDeps,
) => Promise<{ taskId: string; stream: ReadableStream }>;

export type MeshContextFactory = (
  orgId: string,
  userId: string,
) => Promise<MeshContext | null>;

/**
 * Skip reasons:
 *   - `creator_invalid`: org membership lost
 *   - `not_found`, `inactive`: automation went away or was disabled between
 *      schedule fire and workflow body
 */
export type FireAutomationResult =
  | { taskId: string }
  | { taskId: string; error: string }
  | { skipped: "creator_invalid" | "not_found" | "inactive" };

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
