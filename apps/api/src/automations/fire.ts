import type { StudioContext } from "@/core/studio-context";
import { Cron } from "croner";

export type StudioContextFactory = (
  orgId: string,
  userId: string,
) => Promise<StudioContext | null>;

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
