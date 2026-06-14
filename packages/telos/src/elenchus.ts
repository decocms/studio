// @decocms/telos/elenchus — the goal-discovery dialectic.
//
// In the Socratic picture the goal is not given — it is UNCOVERED by questioning.
// Elenchus (cross-examination) is maieutic: it questions/researches a tenant
// until the goal they already half-knew is delivered (recollection). The goal is
// born, not installed.
//
// It returns a PROPOSAL; an authority then installs it via the goal.updated path
// (it becomes the anchor). The Eudaimon never authors its own anchor — the
// elenchus births a candidate, the authority confirms it.

export interface GoalProposal<T> {
  target: T;
  rationale?: string;
  citations?: Array<{ url: string; title?: string }>;
}

export interface Elenchus<T> {
  deliver(tenant: string): Promise<GoalProposal<T>>;
}
