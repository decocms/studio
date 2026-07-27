/**
 * Well-known agents (Super Agent / Decopilot, brand-context-setup) are
 * synthetic — never a real `connections` row — so they can't be deleted.
 */

import { isBrandContextSetup, isDecopilot } from "@decocms/shared/sdk";

export function isUndeletableWellKnownVirtualMcp(id: string): boolean {
  return isDecopilot(id) !== null || isBrandContextSetup(id) !== null;
}
