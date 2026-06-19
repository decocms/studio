import { encodeSubjectToken } from "@decocms/tunnel/subject";

export function buildUserTunnelHostname(userId: string): string {
  return `user-${encodeSubjectToken(userId)}.link`;
}
