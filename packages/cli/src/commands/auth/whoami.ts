import {
  type CredentialOptions,
  resolveCredential,
} from "../../lib/credentials";

/** Prints which credential commands will use, so an agent knows where it is. */
export async function whoamiCommand(
  options: CredentialOptions,
): Promise<number> {
  const credential = await resolveCredential(options);
  if (!credential) return 1;
  switch (credential.kind) {
    case "session":
      console.log(`Target: ${credential.target}`);
      console.log(
        `User:   ${credential.session.user.email ?? credential.session.user.sub}`,
      );
      return 0;
    case "apiKey":
      console.log(`Target: ${credential.target}`);
      console.log("Using:  STUDIO_API_KEY");
      return 0;
    case "run":
      console.log(`Endpoint: ${credential.url}`);
      console.log("Using:    this Studio run's credential");
      return 0;
  }
}
