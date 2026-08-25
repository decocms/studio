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

/**
 * Three addressable fixtures, then enough filler to overflow the list — a
 * three-member org would make the scroll spec pass without scrolling. The
 * filler names and emails share no substring with the searches the specs run
 * ("an", "bruno"), so filtering stays deterministic.
 */
const MEMBERS: MentionMember[] = [
  { id: "u1", name: "valls", email: "valls@deco.cx", image: null },
  { id: "u2", name: "Ana Silva", email: "ana@deco.cx", image: null },
  { id: "u3", name: "Bruno", email: "bruno@deco.cx", image: null },
  ...Array.from({ length: 25 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      id: `f${n}`,
      name: `Coworker ${n}`,
      email: `coworker${n}@deco.cx`,
      image: null,
    };
  }),
];

export function useMentionMembers(_enabled: boolean) {
  return { members: MEMBERS, loading: false };
}
