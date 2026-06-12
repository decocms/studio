/**
 * Builds the <available-agents> + <agents-usage> system-prompt block.
 *
 * Each decopilot run executes inside a single Virtual MCP. The usage
 * guidance is ALWAYS emitted because every agent can delegate to itself
 * (`subtask({ prompt })` clones the current agent with a fresh context).
 * When other active Virtual MCPs exist in the organization they are also
 * listed so the model can delegate cross-agent work via `subtask({ agent_id })`.
 *
 * The block is stable per organization so the prompt prefix can be
 * cached across steps.
 */

const DESCRIPTION_MAX_LEN = 140;

export interface AgentsBlockEntry {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "inactive" | "error";
}

const USAGE_TAIL = `REACH FOR IT ON DISCOVERY: before an open-ended search, or before reading more
than ~3 files / resources / records to answer a question, run subtask FIRST so
the digging burns the subagent's context, not yours. A single, targeted lookup
you already know the shape of stays inline.

Every subtask starts FRESH (no history). Include full context and tell the
subagent exactly what to return (the specific answer/list/paths you need, not
a raw dump); never use continuation phrases like "continue" or "as before".
Launch multiple subtask calls in one message to run independent searches in
parallel.
</agents-usage>`;

// Emitted when other delegable agents exist: documents both the self-clone and
// the cross-agent form, and points at the <available-agents> catalog below.
const FULL_USAGE = `<agents-usage>
Delegate self-contained work to a subagent with the subtask tool.

- subtask({ prompt }) — clone YOURSELF: a fresh subagent with your exact tools
  and instructions but an empty context window.
- subtask({ agent_id, prompt }) — delegate to a DIFFERENT agent (see
  <available-agents>), which has its own tools and instructions.

${USAGE_TAIL}`;

// Emitted when there is NO catalog (self-only). Must NOT reference
// <available-agents> or the agent_id form — that block isn't in context, and a
// dangling pointer makes the model fabricate agent ids instead of just omitting
// agent_id to clone itself.
const SELF_ONLY_USAGE = `<agents-usage>
Delegate self-contained work to a subagent with the subtask tool.

- subtask({ prompt }) — clone YOURSELF: a fresh subagent with your exact tools
  and instructions but an empty context window. This is your ONLY delegation
  option: there are no other agents available, so NEVER pass agent_id.

${USAGE_TAIL}`;

function csvField(s: string | null | undefined): string {
  if (s == null || s === "") return "";
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function buildAgentsBlock(
  agents: AgentsBlockEntry[],
  currentVirtualMcpId: string,
  allowedIds?: string[] | null,
): string {
  let others = agents.filter(
    (a) => a.id !== currentVirtualMcpId && a.status === "active",
  );

  // An allowlist (any array, even empty) restricts delegation to exactly those
  // agents — an empty array means "itself only" (no cross-agent delegation).
  // A null/absent allowlist means "all active agents" (the default behavior).
  if (allowedIds) {
    const allow = new Set(allowedIds);
    others = others.filter((a) => allow.has(a.id));
  }

  // Self-delegation is always available, so the usage guidance is always
  // emitted. The <available-agents> table is added only when other active
  // agents exist to delegate to.
  if (others.length === 0) {
    return `\n\n${SELF_ONLY_USAGE}`;
  }

  const rows = others.map((a) => {
    const desc = truncate(a.description ?? "", DESCRIPTION_MAX_LEN);
    return `${csvField(a.id)},${csvField(a.name)},${csvField(desc)}`;
  });

  return (
    `\n\n<available-agents>\nid,name,description\n${rows.join("\n")}\n</available-agents>` +
    `\n\n${FULL_USAGE}`
  );
}
