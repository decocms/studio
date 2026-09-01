import { z } from "zod";
import {
  type OrgFlags,
  OrgFlagsSchema,
  orgFlagEnabled,
} from "@decocms/shared/organization/schema";

/**
 * A custom-flag key: lowercase snake_case, so a key added here can match a
 * future `OrgFlagsSchema` entry verbatim. Guards against typos/garbage while
 * still allowing keys the deployed schema doesn't know about yet.
 */
export const CustomFlagKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

/**
 * The flags write contract for the admin editor: any snake_case key → boolean.
 * Deliberately NOT `OrgFlagsSchema.strict()` — the editor can set custom keys
 * the deployed schema doesn't list yet. Values stay boolean-only (the rest of
 * the system assumes that).
 */
export const OrgFlagsPatchSchema = z.record(CustomFlagKeySchema, z.boolean());

export type OrgFlagsPatch = z.infer<typeof OrgFlagsPatchSchema>;

/**
 * The flags API's response shape: the raw stored bag (each flag `true`, `false`
 * or absent) plus every flag resolved to its effective boolean via
 * {@link orgFlagEnabled}, so the UI can render current state and default at once.
 *
 * `effective` covers the UNION of schema flags and stored keys, so a custom flag
 * already persisted on the org shows up even though the schema doesn't list it.
 */
export function flagsResponse(stored: OrgFlags | null): {
  flags: Record<string, boolean>;
  effective: Record<string, boolean>;
} {
  const bag = (stored ?? {}) as Record<string, unknown>;
  const keys = new Set<string>([
    ...Object.keys(OrgFlagsSchema.shape),
    ...Object.keys(bag),
  ]);
  const effective: Record<string, boolean> = {};
  for (const key of keys) {
    effective[key] = orgFlagEnabled(bag, key as keyof OrgFlags);
  }
  // Only boolean values are echoed: the jsonb can hold legacy non-boolean values
  // written by hand, which PUT would reject — surfacing them would make the raw
  // JSON editor unsaveable. `effective` still resolves them via orgFlagEnabled.
  const flags: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === "boolean") flags[key] = value;
  }
  return { flags, effective };
}
