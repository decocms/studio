/**
 * The staff kill switch: drops an account's telemetry and analytics at the
 * edge by writing `kill:<site>` for every site of the organization to the
 * denylist (the ingest answers 403; Deco's collector drops the event).
 * Restoring deletes the keys. The org KV remembers the state for the admin
 * screen.
 */

import type { KVStorage } from "@/storage/kv";
import { type Denylist, denylistKeys } from "./denylist";

const STATE_KEY = "hosted-kill";

export interface KillState {
  killed: boolean;
  killedAt: string | null;
}

export async function readKillState(
  kv: KVStorage,
  organizationId: string,
): Promise<KillState> {
  const record = await kv.get(organizationId, STATE_KEY);
  const killedAt =
    typeof record?.killedAt === "string" ? record.killedAt : null;
  return { killed: killedAt !== null, killedAt };
}

export async function setKilled(
  deps: { kv: KVStorage; denylist: Denylist },
  organizationId: string,
  sites: string[],
  killed: boolean,
): Promise<KillState> {
  // OPEN: O-18 — per account means one `kill:<site>` per site the org has
  // now; a site added later is killed by applying the kill again.
  for (const site of new Set(sites)) {
    if (killed) await deps.denylist.put(denylistKeys.kill(site));
    else await deps.denylist.delete(denylistKeys.kill(site));
  }
  if (!killed) {
    await deps.kv.delete(organizationId, STATE_KEY);
    return { killed: false, killedAt: null };
  }
  const killedAt = new Date().toISOString();
  await deps.kv.set(organizationId, STATE_KEY, { killedAt });
  return { killed: true, killedAt };
}
