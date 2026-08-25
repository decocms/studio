/**
 * Stub for `@/hooks/use-mention-members`: the real one calls
 * `useProjectContext()` and Better Auth's org client, neither of which exists
 * under a bare mount. The picker's own behaviour — open, filter, insert — is
 * what the CT specs assert, and that only needs a list.
 */

export interface MentionMember {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

const MEMBERS: MentionMember[] = [
  { id: "u1", name: "valls", email: "valls@deco.cx", image: null },
  { id: "u2", name: "Ana Silva", email: "ana@deco.cx", image: null },
  { id: "u3", name: "Bruno", email: "bruno@deco.cx", image: null },
];

export function useMentionMembers(_enabled: boolean) {
  return { members: MEMBERS, loading: false };
}
