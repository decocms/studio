// Bridges Deco's findings (System Health) AND proposals (CMS) into the REAL
// thread system so they show up as normal tasks in the sidebar and open in the
// real chat:
//   - buildMockTasks(): Task rows seeded into ThreadManagerStore → sidebar +
//     useEnsureTask see them as real threads (no create-on-404).
//   - getMockMessages(): the seeded chat thread for an item — a user turn + the
//     agent's run, rendered through the chat's real tool-call rows + tool UIs.
//   - isMockThread(): the ThreadConnection uses this to serve messages locally
//     (no backend), so the real chat renders them verbatim.
import type { UIMessage } from "ai";
import type { Task } from "@/web/components/chat/task/types";
import { INCIDENTS } from "./mock-data";
import { CMS_PROPOSALS, type CmsProposal } from "./mock-cms";

const METRIC_LABEL: Record<string, string> = {
  "inc-cache-dip": "Cache hit %",
  "inc-pagination": "Sessions reaching page 2",
};

// Fixed, deterministic timestamps so ordering is stable (newest first).
const BASE_MS = Date.parse("2026-06-05T12:00:00Z");
function tsForIndex(idx: number): string {
  return new Date(BASE_MS - idx * 3_600_000).toISOString();
}

export function isMockThread(id: string): boolean {
  return (
    INCIDENTS.some((i) => i.id === id) || CMS_PROPOSALS.some((p) => p.id === id)
  );
}

/** Seed rows for the thread manager — they render as ordinary tasks. */
export function buildMockTasks(virtualMcpId: string): Task[] {
  const items = [
    ...INCIDENTS.map((i) => ({ id: i.id, title: i.title })),
    ...CMS_PROPOSALS.map((p) => ({ id: p.id, title: p.title })),
  ];
  return items.map((item, idx) => ({
    id: item.id,
    title: item.title,
    created_at: tsForIndex(idx),
    updated_at: tsForIndex(idx),
    virtual_mcp_id: virtualMcpId,
    hidden: false,
  }));
}

/** A generic tool-call part — rendered by the chat's GenericToolCallPart (the
 *  same collapsible "tool used" row any real tool call produces). Specific UI
 *  tools (spike, fix, content) are matched by their `tool-*` type in the
 *  message-part switch before the generic fallback. */
function toolCall(
  threadId: string,
  name: string,
  input: unknown,
  output: unknown,
): Record<string, unknown> {
  return {
    type: `tool-${name}`,
    toolCallId: `${threadId}-${name}`,
    state: "output-available",
    input,
    output,
  };
}

function text(body: string): Record<string, unknown> {
  return { type: "text", text: body };
}

/** The seeded chat thread for a System Health finding — a real run with tools. */
function buildIncidentMessages(id: string): UIMessage[] | null {
  const incident = INCIDENTS.find((i) => i.id === id);
  if (!incident) return null;

  const metricLabel = METRIC_LABEL[id] ?? "Errors / min";
  const tone =
    incident.severity === "critical"
      ? "destructive"
      : incident.severity === "warning"
        ? "warning"
        : "muted";

  const parts: Array<Record<string, unknown>> = [];

  // A bit of "thinking" + the tools the agent reached for.
  parts.push(
    toolCall(
      id,
      "investigate_anomaly",
      { signal: incident.title, service: incident.service },
      {
        hypothesis: `Most likely the ${incident.layer} layer`,
        checking: ["error logs", "baseline", "recent releases"],
      },
    ),
  );
  parts.push(
    toolCall(
      id,
      "search_error_logs",
      { source: "HyperDX", service: incident.service, window: "last 24h" },
      {
        matched:
          incident.errorsPerMin > 0
            ? `~${incident.errorsPerMin.toLocaleString()}/min at peak`
            : "0 error logs — silent failure, caught by behaviour",
      },
    ),
  );
  parts.push(
    toolCall(
      id,
      "compare_to_baseline",
      { metric: metricLabel },
      {
        current: incident.errorsPerMin || "—",
        baseline: incident.baseline,
        ratio: incident.multiplier,
      },
    ),
  );

  // Detection summary + the summoned spike graph.
  if (incident.thread[0]) parts.push(text(incident.thread[0].body));
  if (incident.spike.length > 0) {
    parts.push({
      type: "tool-system_health_spike",
      toolCallId: `${id}-spike`,
      state: "output-available",
      input: {},
      output: {
        label: metricLabel,
        points: incident.spike,
        baseline: incident.baseline,
        tone,
      },
    });
  }

  // Trace it to the cause.
  parts.push(
    toolCall(
      id,
      "inspect_recent_releases",
      { window: "24h" },
      { suspect: "yesterday's release", area: incident.service },
    ),
  );

  // Diagnosis + impact (remaining narrative turns).
  for (const m of incident.thread.slice(1)) parts.push(text(m.body));

  // The drafted fix.
  if (incident.fix) {
    parts.push(
      toolCall(
        id,
        "prepare_fix",
        { store: "farmrio" },
        {
          change: incident.fix.pr,
          files_changed: incident.fix.filesChanged,
          qa: incident.fix.qa,
        },
      ),
    );
    parts.push({
      type: "tool-system_health_fix",
      toolCallId: `${id}-fix`,
      state: "output-available",
      input: {},
      output: {
        incidentId: id,
        seedState: incident.state,
        autonomy: incident.autonomy,
        ...incident.fix,
      },
    });
  }

  return [
    {
      id: `${id}-user`,
      role: "user",
      parts: [
        text(
          `Trigger · \`${incident.trigger.event}\`\n\n${incident.trigger.signal}`,
        ),
      ],
    },
    { id: `${id}-assistant`, role: "assistant", parts },
  ] as unknown as UIMessage[];
}

/** The seeded chat thread for a CMS proposal — a real run with content tools. */
function buildCmsMessages(p: CmsProposal): UIMessage[] {
  const parts: Array<Record<string, unknown>> = [];

  // Look at the calendar, then read the current content of the sections it'll
  // touch (the real Content flow: read the section blocks before editing).
  parts.push(
    toolCall(
      p.id,
      "scan_content_calendar",
      { store: "farmrio", window: "next 14 days" },
      {
        upcoming: [
          "Dia das Mães — Sun, May 11",
          "Inverno collection — next Wed",
        ],
      },
    ),
  );
  parts.push(
    toolCall(
      p.id,
      "read_content",
      { sections: p.edits.map((e) => e.resolveType) },
      {
        pages: [...new Set(p.edits.map((e) => e.page))],
        sections: p.edits.length,
      },
    ),
  );

  if (p.thread[0]) parts.push(text(p.thread[0].body));
  if (p.thread[1]) parts.push(text(p.thread[1].body));

  // The content edit UI — a prop diff per section.
  parts.push(
    toolCall(
      p.id,
      "cms_content",
      { edits: p.edits.length },
      {
        proposalId: p.id,
        seedState: p.state,
        autonomy: p.autonomy,
        scope: p.scope,
        edits: p.edits,
      },
    ),
  );

  for (const m of p.thread.slice(2)) parts.push(text(m.body));

  return [
    {
      id: `${p.id}-user`,
      role: "user",
      parts: [text(`Trigger · \`${p.trigger.event}\`\n\n${p.trigger.signal}`)],
    },
    { id: `${p.id}-assistant`, role: "assistant", parts },
  ] as unknown as UIMessage[];
}

export function getMockMessages(id: string): UIMessage[] | null {
  const proposal = CMS_PROPOSALS.find((p) => p.id === id);
  if (proposal) return buildCmsMessages(proposal);
  return buildIncidentMessages(id);
}
