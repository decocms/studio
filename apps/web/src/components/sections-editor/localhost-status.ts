import type { LocalNetworkAccess } from "@/hooks/use-deco-serve-discovery";
import type { ContentBackend } from "./content-backend";
import type { ServeProblem } from "./deco-serve-connection";

/** Where a project's chosen Localhost stands (Blocks v8 sites only). */
export type LocalhostStatus =
  /** First answer pending. */
  | { kind: "connecting" }
  | { kind: "connected" }
  /** Nothing answers: how to start it. Keeps retrying. */
  | { kind: "not-running" }
  /** Chrome blocks Studio from reaching this machine. */
  | { kind: "needs-permission" }
  /** Something answered but can't be used: out of date, another program, … */
  | { kind: "problem"; problem: ServeProblem };

/**
 * A chosen Localhost's state, from the editor's content backend and Chrome's
 * local-network permission, so the preview's guide and the editor never
 * disagree.
 */
export function localhostStatus(input: {
  backend: ContentBackend;
  access: LocalNetworkAccess;
}): LocalhostStatus {
  const { backend } = input;
  if (backend.kind === "protocol" && backend.source === "local") {
    return { kind: "connected" };
  }
  if (backend.kind === "unavailable" && backend.source === "local") {
    const problem = backend.problem;
    if (!problem || problem.reason === "not-answering") {
      return input.access === "denied"
        ? { kind: "needs-permission" }
        : { kind: "not-running" };
    }
    return { kind: "problem", problem };
  }
  return { kind: "connecting" };
}
