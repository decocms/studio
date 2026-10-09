/**
 * The Super Agent (Decopilot) is synthetic — never a real `connections` row —
 * so it can't be deleted.
 */

import { isDecopilot } from "@decocms/shared/sdk";

export function isUndeletableWellKnownVirtualMcp(id: string): boolean {
  return isDecopilot(id) !== null;
}
