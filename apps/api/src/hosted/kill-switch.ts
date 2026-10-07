/**
 * The staff kill switch: drops an account's hosted telemetry at the edge by
 * writing `kill:<site>` for every site the organization owns to the denylist
 * (the ingest answers 403). Restoring deletes the keys. The state shown is
 * read back from the denylist itself; nothing else stores it.
 */

import { type Denylist, denylistKeys } from "./denylist";

export interface KillState {
  killed: boolean;
  killedAt: string | null;
}

/** Killed when any of the sites has `kill:<site>`; `killedAt` is its value. */
export async function readKillState(
  denylist: Denylist,
  sites: string[],
): Promise<KillState> {
  for (const site of new Set(sites)) {
    const killedAt = await denylist.get(denylistKeys.kill(site));
    if (killedAt !== null) return { killed: true, killedAt };
  }
  return { killed: false, killedAt: null };
}

export async function setKilled(
  denylist: Denylist,
  sites: string[],
  killed: boolean,
): Promise<KillState> {
  // OPEN: O-18 — per account means one `kill:<site>` per site the org owns
  // now; a site added later is killed by applying the kill again.
  for (const site of new Set(sites)) {
    if (killed) await denylist.put(denylistKeys.kill(site));
    else await denylist.delete(denylistKeys.kill(site));
  }
  return readKillState(denylist, sites);
}
