import type { JSONContent } from "@tiptap/core";
import type { TiptapDoc } from "@/web/components/chat/types";
import type { SpecialistTemplate } from "./specialist-templates";

interface OrchestratorAutomationArgs {
  template: SpecialistTemplate;
  specialistAgentId: string;
  owner: string;
  repo: string;
  siteRootUrl: string;
}

/**
 * Builds a tiptap doc for the orchestrator's cron-triggered automation message.
 *
 * Round-trip behavior:
 * - Cron path: `derivePartsFromTiptapDoc` resolves the @specialist mention to a
 *   `[DELEGATE TO AGENT: ...]` instruction and concatenates inline text into a
 *   single user-message text part. It does NOT insert separators at paragraph
 *   boundaries, so each non-final paragraph ends with `\n\n` baked into its
 *   last text node — that way step headers don't collide in inlineText.
 * - UI editing: the doc is stored under `metadata.tiptapDoc`, so reopening the
 *   automation in the editor renders the @specialist as a chip and the prose
 *   as paragraphs.
 */
export function buildOrchestratorAutomationDoc(
  args: OrchestratorAutomationArgs,
): TiptapDoc {
  const { template, specialistAgentId, owner, repo, siteRootUrl } = args;
  const subtaskInput = template.buildSubtaskInput({ siteRootUrl });
  // Canonical short identifier — matches the `specialist:` field each prompt
  // self-identifies with (seo, perf, links), and the title-tag in the issue
  // title (e.g. "[seo] ..."). Always derived from issueLabel, not template.id,
  // because the suffix in template.id ("-auditor"/"-watchdog"/"-finder")
  // doesn't map cleanly to the specialist's own identifier.
  const shortTag = template.issueLabel.replace(/^agent:/, "");

  const paragraphs: JSONContent[] = [];

  paragraphs.push(
    paragraph([
      text(
        `Daily ${template.title} run for ${owner}/${repo}, monitoring ${siteRootUrl}.\n\n` +
          `Your job: call the specialist sub-agent for fresh findings, dedup against the repo's open issues, and either file new issues or comment on existing ones. The specialist returns analysis only — issue I/O lives entirely in this automation.`,
      ),
    ]),
  );

  paragraphs.push(
    paragraph([
      text(
        `Step 1 — Read current state.\n` +
          `Call list_issues with:\n` +
          `  owner: "${owner}"\n` +
          `  repo: "${repo}"\n` +
          `  labels: ["${template.issueLabel}", "auto-generated"]\n` +
          `  state: "open"\n` +
          `For each issue, parse the YAML frontmatter at the top of the body and extract { kind, target.route }. This is your "known problems" map.`,
      ),
    ]),
  );

  paragraphs.push(
    paragraph([
      text(`Step 2 — Get fresh findings from `),
      agentMention({
        agentId: specialistAgentId,
        title: template.title,
      }),
      text(
        `. Use the subtask tool with that agent and pass exactly this YAML as the prompt:\n\n${subtaskInput.trimEnd()}\n\nThe specialist returns a structured report:\n` +
          `  specialist: <id>\n` +
          `  summary: { ... }\n` +
          `  findings:\n` +
          `    - { kind, severity, target: { url, route }, evidence, impact, suggested_fix }\n` +
          `If findings is empty, the site is healthy for this specialist — skip to Step 5.`,
      ),
    ]),
  );

  paragraphs.push(
    paragraph([
      text(
        `Step 3 — For each finding, decide what to do based on the known-problems map from Step 1:\n` +
          `  • No open issue with the same { kind, target.route } → create a new issue (Step 4).\n` +
          `  • Open issue exists with same { kind, target.route } → add a comment: "Still present." and include the latest evidence verbatim.\n` +
          `  • A previously-open issue's { kind, target.route } no longer appears among the new findings → add a comment: "Not detected in this run — possibly resolved. Leaving open for human confirmation." Do NOT close the issue.\n` +
          `When in doubt, prefer commenting over creating. Duplicate issues erode maintainer trust.`,
      ),
    ]),
  );

  paragraphs.push(
    paragraph([
      text(
        `Step 4 — Issue format. Set once at creation; NEVER edit the body afterwards.\n` +
          `Use issue_write with method: "create" and:\n` +
          `  title: "[${shortTag}] <short summary> — <route>"\n` +
          `  labels: ["${template.issueLabel}", "auto-generated", "severity:<low|medium|high>"]\n` +
          `  body:\n` +
          `---\n` +
          `specialist: ${shortTag}\n` +
          `kind: <kind>\n` +
          `severity: <low|medium|high>\n` +
          `target:\n` +
          `  url: <full URL>\n` +
          `  route: <normalized path>\n` +
          `---\n\n` +
          `## Finding\n<1–2 sentences from the specialist's finding>\n\n` +
          `## Evidence\n<evidence block from the specialist verbatim>\n\n` +
          `## Impact\n<impact from the specialist>\n\n` +
          `## Suggested Fix\n<suggested_fix from the specialist>`,
      ),
    ]),
  );

  paragraphs.push(
    paragraph([
      text(
        `Step 5 — Wrap up with a one-paragraph summary: how many findings, how many issues created, how many re-detected (commented), how many possibly-resolved (commented).`,
      ),
    ]),
  );

  paragraphs.push(
    paragraph([
      text(
        `Rules:\n` +
          `  • Never edit issue bodies after creation — use comments.\n` +
          `  • Never close issues automatically. At most, comment "possibly resolved".\n` +
          `  • Never touch issues that don't have BOTH "${template.issueLabel}" AND "auto-generated" labels.\n` +
          `  • One issue per { kind, target.route } pair. Dedup uses those two fields from the body frontmatter.\n` +
          `  • Always normalize route: lowercase host, no trailing slash (except "/"), no query string, no fragment.`,
      ),
    ]),
  );

  return {
    type: "doc",
    content: paragraphs.map((p, i) =>
      i < paragraphs.length - 1 ? withTrailingBreak(p) : p,
    ),
  };
}

/**
 * `derivePartsFromTiptapDoc` concatenates text without inserting separators at
 * paragraph boundaries, so we bake a trailing `\n\n` into each non-final
 * paragraph's last text node. Renders as collapsed whitespace in the editor;
 * preserves section breaks in the cron-time inlineText.
 */
function withTrailingBreak(p: JSONContent): JSONContent {
  const content = p.content;
  if (!content || content.length === 0) return p;
  const last = content[content.length - 1];
  if (!last || last.type !== "text" || typeof last.text !== "string") return p;
  return {
    ...p,
    content: [...content.slice(0, -1), { ...last, text: `${last.text}\n\n` }],
  };
}

function paragraph(content: JSONContent[]): JSONContent {
  return { type: "paragraph", content };
}

function text(value: string): JSONContent {
  return { type: "text", text: value };
}

function agentMention({
  agentId,
  title,
}: {
  agentId: string;
  title: string;
}): JSONContent {
  return {
    type: "mention",
    attrs: {
      id: agentId,
      name: title,
      char: "@",
      metadata: { agentId, title },
    },
  };
}
