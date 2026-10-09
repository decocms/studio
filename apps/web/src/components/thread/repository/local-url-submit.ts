/**
 * What the draft selector's "Local" option does with what was pasted.
 *
 * A `deco serve` (Blocks v8) answers its probe and is connected. Anything
 * else is saved as a v7 tunnel URL exactly as before `deco serve` existed —
 * including `http://localhost:PORT`, `127.0.0.1:PORT` and a bare port whose
 * probe failed: those are v7 dev servers as much as stopped `deco serve`s.
 * Only a Site editor link, which never names anything but a `deco serve`,
 * reports the probe's failure instead.
 *
 * Pure but for the injected probe: unit-tested without a browser.
 */

import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";
import {
  type DecoServeConnection,
  parseConnectLink,
  parseServeAddress,
} from "@/components/sections-editor/deco-serve-connection";

export type LocalSubmitOutcome =
  /** A `deco serve` answered: connect it. */
  | { kind: "serve"; connection: DecoServeConnection }
  /** Save as the v7 tunnel URL (`null` turns Local off, as on main). */
  | { kind: "tunnel"; url: string | null }
  /** A Site editor link whose `deco serve` didn't answer. */
  | { kind: "serve-error"; connection: DecoServeConnection; failure: unknown };

export async function resolveLocalSubmit(
  input: string,
  probe: (endpoint: string) => Promise<unknown>,
): Promise<LocalSubmitOutcome> {
  const trimmed = input.trim();
  const parsed = parseServeAddress(trimmed);
  if (!parsed.ok)
    return { kind: "tunnel", url: productionUrlFromDomain(trimmed) };
  const { connection } = parsed;
  try {
    await probe(connection.endpoint);
    return { kind: "serve", connection };
  } catch (failure) {
    if (parseConnectLink(trimmed)) {
      return { kind: "serve-error", connection, failure };
    }
    return { kind: "tunnel", url: productionUrlFromDomain(trimmed) };
  }
}
