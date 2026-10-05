import {
  type CredentialOptions,
  resolveCredential,
} from "../../lib/credentials";
import { print } from "../../lib/output";

/** Prints which credential commands will use, so an agent knows where it is. */
export async function whoamiCommand(
  options: CredentialOptions,
): Promise<number> {
  const credential = await resolveCredential(options);
  if (!credential) return 1;
  switch (credential.kind) {
    case "session":
      print(`Target: ${credential.target}`);
      print(
        `User:   ${credential.session.user.email ?? credential.session.user.sub}`,
      );
      return 0;
    case "apiKey":
      print(`Target: ${credential.target}`);
      print("Using:  STUDIO_API_KEY");
      return 0;
    case "run":
      print(`Endpoint: ${credential.url}`);
      print("Using:    this Studio run's credential");
      return 0;
  }
}
