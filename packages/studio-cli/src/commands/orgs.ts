import { z } from "zod";
import {
  type RequestIo,
  studioFetch,
  writeResponse,
} from "../lib/studio-request";
import {
  type CredentialOptions,
  resolveRestCredential,
} from "../lib/credentials";

export interface OrgsOptions extends CredentialOptions, RequestIo {
  /** Print the full response instead of one line per organization. */
  json?: boolean;
}

const OrganizationsSchema = z.object({
  organizations: z.array(
    z.looseObject({ id: z.string(), slug: z.string(), name: z.string() }),
  ),
});

/** `decocms orgs` — the organizations the logged-in user belongs to. */
export async function orgsCommand(options: OrgsOptions): Promise<number> {
  const auth = await resolveRestCredential(options, "orgs");
  if (!auth) return 1;

  const res = await studioFetch(auth, "/api/_me/organizations", {
    method: "GET",
    fetch: options.fetch,
  });
  if (!res.ok) return writeResponse(res, auth, options.output);

  const parsed = OrganizationsSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.error("Unexpected response from the organizations endpoint.");
    return 1;
  }
  const { organizations } = parsed.data;
  if (options.json) {
    console.log(JSON.stringify(organizations));
    return 0;
  }
  for (const org of organizations) {
    console.log(`${org.slug}\t${org.name}`);
  }
  return 0;
}
