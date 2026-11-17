import type { passkey } from "@better-auth/passkey";

type PasskeyOptions = NonNullable<Parameters<typeof passkey>[0]>;

/**
 * WebAuthn binds a credential to the relying party id (the hostname), so it
 * must come from the public base URL rather than the request host. The
 * localhost/127.0.0.1 alias in `trustedOrigins` cannot share a credential:
 * they are different RP ids.
 */
export function createPasskeyConfig(baseUrl: string): PasskeyOptions {
  const url = new URL(baseUrl);
  return {
    rpID: url.hostname,
    rpName: "deco Studio",
    origin: url.origin,
  };
}
