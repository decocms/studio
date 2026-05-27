import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download01,
  FileCode01,
  Loading01,
  Palette,
  Plus,
  Settings02,
} from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  composeAndSubmitChatInput,
  composeChatInput,
} from "@/web/lib/chat-input-bridge";
import { KEYS } from "@/web/lib/query-keys";
import { useChatTask } from "@/web/components/chat";
import { useOptionalChatStream } from "@/web/components/chat/context";

const PROMPT_MESSAGE_TYPE = "page-editor:prompt";
const PROMPT_AND_SEND_MESSAGE_TYPE = "page-editor:prompt-and-send";
const RUNTIME_ERROR_MESSAGE_TYPE = "page-editor:runtime-error";
const HOST_SELECT_DS_MESSAGE_TYPE = "page-editor:host-select-ds";
const HOST_CLOSE_DS_GRID_MESSAGE_TYPE = "page-editor:host-close-ds-grid";
const HOST_REQUEST_REFRESH_MESSAGE_TYPE = "page-editor:host-request-refresh";
const HOST_READY_MESSAGE_TYPE = "host:ready";
// Every preview-related tool — used to detect "the agent has started doing
// preview work in this chat" (exit fresh-chat / exit thinking-intermission).
const PREVIEW_STATE_TOOLS = new Set([
  "PAGE_PREVIEW_SET",
  "PAGE_PREVIEW_REFRESH",
  "PAGE_PREVIEW_PAGE_CREATE",
  "PAGE_PREVIEW_PROGRESS",
  "DESIGN_SYSTEM_CREATE",
  "DESIGN_SYSTEM_SET",
  "PAGE_BOOTSTRAP",
  "PAGE_RENDER_BLOCK",
  "PAGE_UPDATE_BLOCK",
  "PAGE_REMOVE_BLOCK",
]);

/**
 * Browser-as-REPL block tools — observed in the chat stream to drive
 * direct iframe postMessages. The tool args carry the section + props;
 * Studio just relays them. No disk I/O, no /state refetch.
 */
const BLOCK_PATCH_TOOLS = new Set([
  "PAGE_RENDER_BLOCK",
  "PAGE_UPDATE_BLOCK",
  "PAGE_REMOVE_BLOCK",
]);

// Tools that change on-disk state (the listing returned by /state). Used to
// gate the refetch trigger so PAGE_PREVIEW_PROGRESS (in-memory only)
// doesn't cause a refetch — refetching with each progress label briefly
// flips `status` to undefined, which collapses `pages = []` and yanks the
// intent back to the welcome screen until the new fetch resolves.
const DISK_MUTATING_TOOLS = new Set([
  "PAGE_PREVIEW_SET",
  "PAGE_PREVIEW_REFRESH",
  "PAGE_PREVIEW_PAGE_CREATE",
  "DESIGN_SYSTEM_CREATE",
  "DESIGN_SYSTEM_SET",
  "PAGE_BOOTSTRAP",
]);

// Re-use the runtime-validated shapes from the server side so any new
// fields land here automatically instead of needing a hand-sync. The
// service.ts type definitions are the contract; this tab is just a
// consumer of /api/{org}/page-preview/state.
import type {
  DesignSystemEntry,
  PagePreviewPage as PageEntry,
  PagePreviewStatus,
  PreviewKind,
} from "@/page-preview/service";

/**
 * Aggregate "what did the agent build in *this chat*?" by walking the
 * stream for tool calls. The iframe is restricted to items that appear
 * here so the agent can't drag the preview onto an unrelated page from a
 * prior session via PAGE_PREVIEW_SET on a stale slug.
 *
 * Returns:
 *   designSystemSlug   slug of the latest DESIGN_SYSTEM_CREATE call
 *   pageSlug           slug of the latest PAGE_PREVIEW_PAGE_CREATE call
 *   pageActivated      true once the agent has SET / REFRESHED the page,
 *                      meaning it's ready to be the preview (otherwise
 *                      the design system keeps showing)
 */
type SessionItems = {
  designSystemSlug: string | null;
  pageSlug: string | null;
  pageActivated: boolean;
};

type ManualArtifacts = {
  designSystemSlug: string | null;
  pageSlug: string | null;
};

/**
 * Pull a page slug out of whatever PAGE_PREVIEW_SET's `path` arg looks
 * like. The agent passes any of:
 *   "pricing"
 *   "pricing/index.html"
 *   "pages/pricing/index.html"
 *   "/abs/.deco/page-editor/pages/pricing/index.html"
 */
function extractPageSlugFromPath(path: string): string | null {
  if (!path) return null;
  const m =
    path.match(/(?:^|\/)pages\/([^/?#]+)/) ??
    path.match(/^([A-Za-z0-9][\w-]*?)(?:\/|$)/);
  return m?.[1] ?? null;
}

function deriveSessionItems(
  messages: Array<{ parts?: unknown[] }>,
): SessionItems {
  let designSystemSlug: string | null = null;
  let pageSlug: string | null = null;
  let pageActivated = false;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (!toolName) continue;
      const record = part as Record<string, unknown>;
      const state =
        typeof record.state === "string" ? record.state : "output-available";
      // Honor only *successful* tool results. `output-error` carries the
      // same prefix but means the call failed — using its args would
      // chase a slug that was never written to disk.
      if (state !== "output-available") continue;
      if (/write|edit/i.test(toolName)) {
        const manualArtifacts = extractManualArtifacts(record);
        if (manualArtifacts.designSystemSlug) {
          designSystemSlug = manualArtifacts.designSystemSlug;
        }
        if (manualArtifacts.pageSlug) {
          pageSlug = manualArtifacts.pageSlug;
          pageActivated = true;
        }
      }
      if (toolName === "PAGE_BOOTSTRAP") {
        // Combined tool: sets both the page slug AND the derived DS slug
        // (<slug>-ds) AND activates the page in one shot.
        const slug = extractToolArgString(record, "slug");
        if (slug) {
          pageSlug = slug;
          designSystemSlug = `${slug}-ds`;
          pageActivated = true;
        }
      } else if (toolName === "DESIGN_SYSTEM_CREATE") {
        const slug = extractToolArgString(record, "slug");
        if (slug) designSystemSlug = slug;
      } else if (toolName === "PAGE_PREVIEW_PAGE_CREATE") {
        const slug = extractToolArgString(record, "slug");
        if (slug) {
          pageSlug = slug;
          // CREATE activates the page (server-side activate is always true
          // now — see tools/page-preview/index.ts: PAGE_PREVIEW_PAGE_CREATE).
          // Pre-REPL the page would stay inactive until SET/REFRESH so the
          // DS preview kept showing during the blank-page window, but with
          // browser-as-REPL the iframe renders sections live the moment they
          // arrive — no blank-page window exists. Activating here mirrors
          // the server so the Studio intent ladder resolves to "page"
          // (not "ds-demo") when the agent's turn ends, preventing the
          // post-build host:show-design-system that wipes REPL-rendered
          // blocks.
          pageActivated = true;
        }
      } else if (toolName === "PAGE_RENDER_BLOCK") {
        // The REPL path bypasses SET/REFRESH entirely. As soon as the
        // agent ships a block, the page is the active artifact —
        // regardless of which scaffold tool ran before. Defensive in case
        // a future flow ships blocks without PAGE_CREATE (or for legacy
        // pages already on disk).
        const slug = extractToolArgString(record, "slug");
        if (slug) {
          pageSlug = slug;
          pageActivated = true;
        }
      } else if (toolName === "PAGE_PREVIEW_SET") {
        // SET to ANY slug counts. Studio side filters against the
        // on-disk pages list, so a typo / stale slug still won't be
        // shown — but a valid SET to an existing page will be honored.
        const target = extractToolArgString(record, "path") ?? "";
        const slugFromPath = extractPageSlugFromPath(target);
        if (slugFromPath) {
          pageSlug = slugFromPath;
          pageActivated = true;
        }
      } else if (toolName === "PAGE_PREVIEW_REFRESH") {
        if (pageSlug) pageActivated = true;
      }
    }
  }
  return { designSystemSlug, pageSlug, pageActivated };
}

/**
 * Pull the most recent user-authored prompt from the chat stream so the
 * preview can echo it back during the "thinking" intermission (the
 * window between the user hitting Send and the agent firing its first
 * preview-state tool — which can be 30s–2min while the agent reads
 * files, does brand-context lookups, plans, etc.).
 *
 * The stream's message shapes differ by transport; we probe several:
 *   - { role: 'user', content: '…' | [{ type: 'text', text: '…' }] }
 *   - { role: 'user', parts: [{ type: 'text', text: '…' } | { text: '…' }] }
 */
function deriveLatestUserPrompt(
  messages: Array<Record<string, unknown>>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] ?? {};
    const role = m.role;
    if (role !== "user") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .map((c) => {
          if (typeof c === "string") return c;
          if (c && typeof c === "object") {
            const t = (c as Record<string, unknown>).text;
            if (typeof t === "string") return t;
          }
          return "";
        })
        .join(" ")
        .trim();
      if (text) return text;
    }
    const parts = (m as { parts?: unknown[] }).parts ?? [];
    const partText = (parts as Array<Record<string, unknown>>)
      .map((p) => {
        if (typeof p.text === "string") return p.text;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .join(" ")
      .trim();
    if (partText) return partText;
  }
  return null;
}

/**
 * True iff *any* preview-state tool call has fired this session — used
 * to know when the "thinking" intermission should end (we have real
 * progress to show now).
 */
function hasAnyPreviewToolFired(
  messages: Array<{ parts?: unknown[] }>,
): boolean {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (!toolName) continue;
      if (!PREVIEW_STATE_TOOLS.has(toolName)) continue;
      const record = part as Record<string, unknown>;
      const state =
        typeof record.state === "string" ? record.state : "output-available";
      if (state === "output-available") return true;
    }
  }
  return false;
}

/**
 * Walk the chat stream and return the latest agent-declared section outline
 * for the page being built. PAGE_PREVIEW_PROGRESS takes an optional
 * outline:string[] field that the host renders as a sticky stepper.
 *
 * Outline persists for the entire build — the agent declares it once on
 * the first PROGRESS call, and that plan applies through DS_CREATE,
 * PAGE_CREATE, every SET / REFRESH. A subsequent PROGRESS that passes a
 * new outline replaces it. Nothing else clears it.
 */
function deriveLiveOutline(
  messages: Array<{ parts?: unknown[] }>,
): string[] | null {
  let outline: string[] | null = null;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (!toolName) continue;
      const record = part as Record<string, unknown>;
      const state =
        typeof record.state === "string" ? record.state : "output-available";
      if (state !== "output-available") continue;
      if (
        toolName === "PAGE_PREVIEW_PROGRESS" ||
        toolName === "PAGE_BOOTSTRAP"
      ) {
        const candidate = extractToolArgArray(record, "outline");
        if (candidate) outline = candidate;
      }
    }
  }
  return outline;
}

export type ReviewTip = {
  id: string;
  section: string;
  prompt: string;
};

/**
 * Walk the chat stream and collect PAGE_REVIEW_SUGGEST calls into a list
 * of tips. Each tip has a stable id (so the iframe can dedupe across
 * re-derivations) and the section + prompt the agent emitted.
 *
 * Reads at any non-error state — we want the tooltip to appear as the
 * agent's argument streams in, not only after output-available, so
 * critique feedback feels live like the body sections did.
 */
function deriveReviewTips(messages: Array<{ parts?: unknown[] }>): ReviewTip[] {
  const out: ReviewTip[] = [];
  let positional = 0;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (toolName !== "PAGE_REVIEW_SUGGEST") continue;
      const record = part as Record<string, unknown>;
      const state =
        typeof record.state === "string" ? record.state : "output-available";
      if (state === "output-error") continue;
      const section = extractToolArgString(record, "section");
      // Accept either `prompt` (current) or `suggestion` (older field
      // the agent may still emit if it falls back to remembered tool
      // shapes). Surfacing both prevents tooltips from silently going
      // missing when the field name drifts.
      const prompt =
        extractToolArgString(record, "prompt") ??
        extractToolArgString(record, "suggestion");
      if (!section || !prompt) continue;
      const id =
        typeof record.toolCallId === "string"
          ? `tip:${record.toolCallId}`
          : `tip:#${positional++}`;
      out.push({ id, section, prompt });
    }
  }
  return out;
}

/**
 * Pull an array-of-strings argument from a tool-call record. Same probing
 * strategy as `extractToolArgString` but for array values.
 */
function extractToolArgArray(
  record: Record<string, unknown>,
  key: string,
): string[] | null {
  const buckets: unknown[] = [
    record.input,
    record.args,
    (record.params as Record<string, unknown> | undefined)?.arguments,
  ];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const value = (bucket as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      const cleaned = value
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((s) => s.trim());
      if (cleaned.length > 0) return cleaned;
    }
  }
  return null;
}

/**
 * Walk the chat stream in order and return the live progress-pill label.
 *
 * Source priority: an explicit PAGE_PREVIEW_PROGRESS({ label }) call wins;
 * otherwise the label is *derived* from the most recent block-affecting
 * tool's input args (DS_CREATE / PAGE_CREATE / RENDER_BLOCK / UPDATE_BLOCK /
 * REMOVE_BLOCK). The last derivable label in stream order wins.
 *
 * Tool-call args live in different shapes depending on Claude Code's
 * streaming protocol. We probe the common locations.
 */
function deriveLiveProgress(
  messages: Array<{ parts?: unknown[] }>,
  isTaskRunning: boolean,
): string | null {
  // Walk every tool call in stream order; the LAST one with a derivable
  // label wins. We pick up labels at any state (input-streaming included)
  // so the pill flips the moment the agent commits to a tool — no waiting
  // for output-available, no need for the agent to call
  // PAGE_PREVIEW_PROGRESS first.
  //
  // For non-PROGRESS tools we derive the label from their input args:
  //   DESIGN_SYSTEM_CREATE     → "Applying <template>…"
  //   PAGE_PREVIEW_PAGE_CREATE → "Building the layout…"
  //   PAGE_RENDER_BLOCK        → "Adding <section>…"
  //   PAGE_UPDATE_BLOCK        → "Polishing…"
  // This lets the system prompt drop the per-section PROGRESS calls —
  // saves ~5 tool round-trips per build (one per body section). The pill
  // also no longer leads the visual by 3-5 s of model-think time; it
  // appears the moment the agent starts streaming the tool args.
  // The pill should reflect what's IN FLIGHT, not what just completed. A
  // PAGE_RENDER_BLOCK that's reached output-available is already rendered
  // in the iframe — saying "Adding Footer…" while Footer is visible at
  // the bottom of the page is stale and confusing (the user just hit this
  // bug). We track the latest IN-FLIGHT tool's label; once it completes,
  // the label clears unless another tool is still streaming.
  //
  // In-flight = state is one of input-streaming, input-available, or
  // explicit/derived but NOT output-available / output-error. With
  // parallel tool emission, multiple may be in-flight at once; pick the
  // last one in stream order (close enough for a single-line pill).
  //
  // PAGE_PREVIEW_PROGRESS is a special case — its label is the agent's
  // explicit hint, and it remains "current" until a later tool overrides
  // it. We honor it whether or not it's strictly in-flight.
  let label: string | null = null;
  // Track first-pass completion to surface a "Reviewing the page…" pill
  // in the lull between the LAST RENDER_BLOCK landing and the FIRST
  // PAGE_REVIEW_SUGGEST. Without this beat the user sees the pill flash
  // from "Adding Footer…" → blank → "Adding suggestion…" — feels broken.
  let outline: string[] | null = null;
  let completedRenderSections = 0;
  let reviewStarted = false;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (!toolName) continue;
      const record = part as Record<string, unknown>;
      const callState =
        typeof record.state === "string" ? record.state : "output-available";
      if (callState === "output-error") {
        label = null;
        continue;
      }
      // Side-channel: track outline + render completions for the
      // "Reviewing" beat below.
      if (
        toolName === "PAGE_PREVIEW_PROGRESS" ||
        toolName === "PAGE_BOOTSTRAP"
      ) {
        const candidate = extractToolArgArray(record, "outline");
        if (candidate) outline = candidate;
      }
      if (
        toolName === "PAGE_RENDER_BLOCK" &&
        callState === "output-available"
      ) {
        completedRenderSections += 1;
      }
      if (toolName === "PAGE_REVIEW_SUGGEST") reviewStarted = true;
      // PROGRESS sets a label even after completion (it's a hint, not an
      // active operation). All other tools clear themselves once done.
      if (toolName === "PAGE_PREVIEW_PROGRESS") {
        const explicit =
          extractToolArgString(record, "label") ??
          extractToolArgString(record, "input.label");
        if (explicit) label = explicit;
        continue;
      }
      const isInFlight = callState !== "output-available";
      if (!isInFlight) {
        // Completed work — clear any stale "Adding X…" label that referred
        // to this same tool call so the pill disappears once the section
        // is visibly rendered.
        label = null;
        continue;
      }
      if (toolName === "PAGE_BOOTSTRAP") {
        const tpl = extractToolArgString(record, "template");
        label = tpl ? `Applying ${tpl}…` : "Bootstrapping the page…";
      } else if (toolName === "DESIGN_SYSTEM_CREATE") {
        const tpl = extractToolArgString(record, "template");
        label = tpl ? `Applying ${tpl}…` : "Applying design system…";
      } else if (toolName === "PAGE_PREVIEW_PAGE_CREATE") {
        label = "Building the layout…";
      } else if (toolName === "PAGE_RENDER_BLOCK") {
        const section = extractToolArgString(record, "section");
        label = section ? `Adding ${section}…` : "Adding section…";
      } else if (toolName === "PAGE_UPDATE_BLOCK") {
        label = "Polishing…";
      } else if (toolName === "PAGE_REMOVE_BLOCK") {
        label = "Removing section…";
      } else if (toolName === "PAGE_REVIEW_SUGGEST") {
        label = "Reviewing the page…";
      }
    }
  }
  // Special "Reviewing" beat: the first pass (all outline sections) is
  // complete AND the agent hasn't started the review pass yet AND no
  // other label is fresher. Filling the gap with "Reviewing…" tells the
  // user the page is structurally done and critique is incoming.
  // Only surface the "Reviewing the page…" beat while a task is actually
  // running. Without this gate, after F5 the rehydrated stream still has
  // every prior output-available RENDER_BLOCK call, so the fallback
  // condition stays true forever and the pill is stuck.
  if (
    label === null &&
    isTaskRunning &&
    outline &&
    outline.length > 0 &&
    completedRenderSections >= outline.length &&
    !reviewStarted
  ) {
    label = "Reviewing the page…";
  }
  return label;
}

function extractToolArgString(
  record: Record<string, unknown>,
  path: string,
): string | null {
  const parts = path.split(".");
  // Common shapes from the Claude Code streaming protocol:
  //   { input: { label: "…" } }
  //   { args:  { label: "…" } }
  //   { params:{ arguments: { label: "…" } } }
  const buckets: unknown[] = [
    record.input,
    record.args,
    (record.params as Record<string, unknown> | undefined)?.arguments,
  ];
  for (const bucket of buckets) {
    let cur: unknown = bucket;
    for (const key of parts) {
      if (!cur || typeof cur !== "object") {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur === "string" && cur.trim().length > 0) return cur.trim();
  }
  return null;
}

/**
 * Probe the same arg-shape buckets as extractToolArgString, but return the
 * raw value (any type). Used to lift block props / position / index off
 * BLOCK_PATCH_TOOLS calls in the chat stream so we can postMessage them
 * to the iframe without going through the server's response payload.
 */
function extractToolArgAny(
  record: Record<string, unknown>,
  key: string,
): unknown {
  const buckets: unknown[] = [
    record.input,
    record.args,
    (record.params as Record<string, unknown> | undefined)?.arguments,
  ];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const value = (bucket as Record<string, unknown>)[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Walk the chat stream and return every block-patch tool call in order
 * with a stable identifier (`toolCallId` if available, else a positional
 * fallback). Studio re-runs this on every stream change and only
 * postMessages calls whose ids haven't been dispatched yet.
 */
type BlockPatchCall =
  | {
      id: string;
      kind: "render";
      slug: string | null;
      section: string;
      props: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "update";
      slug: string | null;
      index: number;
      props: Record<string, unknown>;
      replace: boolean;
    }
  | { id: string; kind: "remove"; slug: string | null; index: number };

function deriveBlockPatchCalls(
  messages: Array<{ parts?: unknown[] }>,
): BlockPatchCall[] {
  const out: BlockPatchCall[] = [];
  let positional = 0;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (!toolName || !BLOCK_PATCH_TOOLS.has(toolName)) continue;
      const record = part as Record<string, unknown>;
      const state =
        typeof record.state === "string" ? record.state : "output-available";
      // Honor only successful tool results — failed calls didn't mutate
      // server state, so the iframe shouldn't try to apply them either.
      if (state !== "output-available") continue;
      const id =
        typeof record.toolCallId === "string"
          ? `${toolName}:${record.toolCallId}`
          : `${toolName}:#${positional++}`;
      const slug = extractToolArgString(record, "slug");
      if (toolName === "PAGE_RENDER_BLOCK") {
        const section = extractToolArgString(record, "section");
        const props = extractToolArgAny(record, "props");
        if (!section) continue;
        out.push({
          id,
          kind: "render",
          slug,
          section,
          props:
            props && typeof props === "object"
              ? (props as Record<string, unknown>)
              : {},
        });
      } else if (toolName === "PAGE_UPDATE_BLOCK") {
        const idx = extractToolArgAny(record, "index");
        const props = extractToolArgAny(record, "props");
        const replace = extractToolArgAny(record, "replace");
        if (typeof idx !== "number") continue;
        out.push({
          id,
          kind: "update",
          slug,
          index: idx,
          props:
            props && typeof props === "object"
              ? (props as Record<string, unknown>)
              : {},
          replace: replace === true,
        });
      } else if (toolName === "PAGE_REMOVE_BLOCK") {
        const idx = extractToolArgAny(record, "index");
        if (typeof idx !== "number") continue;
        out.push({ id, kind: "remove", slug, index: idx });
      }
    }
  }
  return out;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function partToolName(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  if (typeof record.toolName === "string") {
    for (const toolName of PREVIEW_STATE_TOOLS) {
      if (record.toolName.includes(toolName)) return toolName;
    }
    return record.toolName;
  }
  if (typeof record.name === "string") {
    for (const toolName of PREVIEW_STATE_TOOLS) {
      if (record.name.includes(toolName)) return toolName;
    }
    return record.name;
  }
  if (typeof record.type === "string") {
    for (const toolName of PREVIEW_STATE_TOOLS) {
      if (
        record.type === `tool-${toolName}` ||
        record.type.includes(toolName)
      ) {
        return toolName;
      }
    }
  }
  return null;
}

function previewStateToolKey(messages: Array<{ parts?: unknown[] }>): string {
  const keys: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolName = partToolName(part);
      if (!toolName) continue;
      const record = part as Record<string, unknown>;
      const state =
        typeof record.state === "string" ? record.state : "output-available";
      // Honor only *successful* tool results. `output-error` carries the
      // same prefix but means the call failed — using its args would
      // chase a slug that was never written to disk.
      if (state !== "output-available") continue;
      const manualArtifacts = extractManualArtifacts(record);
      const isManualArtifactMutation =
        /write|edit/i.test(toolName) &&
        (manualArtifacts.designSystemSlug !== null ||
          manualArtifacts.pageSlug !== null);
      if (!DISK_MUTATING_TOOLS.has(toolName) && !isManualArtifactMutation) {
        continue;
      }
      keys.push(
        typeof record.toolCallId === "string"
          ? `${toolName}:${record.toolCallId}`
          : `${toolName}:${keys.length}`,
      );
    }
  }
  return keys.join("|");
}

/**
 * Direct file writes are not the happy path, but some agents still author
 * page-editor files manually instead of calling the scaffold tools. When that
 * happens we can still keep the preview alive by inferring the latest touched
 * page / design-system slug from the tool payload.
 */
function extractManualArtifacts(
  record: Record<string, unknown>,
): ManualArtifacts {
  const haystack = JSON.stringify(record);
  const designSystemMatch = haystack.match(
    /(?:^|[\\/])page-editor[\\/]design-systems[\\/]([^\\/"']+)/,
  );
  const pageMatch = haystack.match(
    /(?:^|[\\/])page-editor[\\/]pages[\\/]([^\\/"']+)/,
  );
  return {
    designSystemSlug: designSystemMatch?.[1] ?? null,
    pageSlug: pageMatch?.[1] ?? null,
  };
}

export function PagePreviewTab() {
  const { org } = useProjectContext();
  const { taskId, activeTask } = useChatTask();
  const stream = useOptionalChatStream();
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [forceWelcome, setForceWelcome] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [dsMenuOpen, setDsMenuOpen] = useState(false);
  const [override, setOverride] = useState<
    | { kind: "page"; slug: string }
    | { kind: "design-system"; slug: string }
    | null
  >(null);
  // Manage-design-systems grid view (top-level mode override).
  const [gridOpen, setGridOpen] = useState(false);
  // When the user toggles a different design system in the dropdown while
  // a page is showing, we *retheme* the page instead of replacing it.
  // This slug overrides the page's bound DS for the current view.
  const [themeOverrideSlug, setThemeOverrideSlug] = useState<string | null>(
    null,
  );
  // Tracks whether the host iframe finished its handshake. We hold off on
  // sending intent messages until the host signals readiness.
  const [hostReady, setHostReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostUrl = `/api/${encodeURIComponent(org.slug)}/page-preview/host`;
  // Iframe dynamic-imports use this base for `/files/<key>` lookups. After
  // the storage migration, page-preview assets live under Studio's
  // canonical /api/{org}/files/{key} redirect (page-preview/...).
  const filesBase = `/api/${encodeURIComponent(org.slug)}/files/page-preview`;
  const taskStatus =
    activeTask?.id === taskId ? (activeTask?.status ?? null) : null;
  const [lastTaskStatus, setLastTaskStatus] = useState<string | null>(
    taskStatus,
  );
  const [lastPreviewRefreshKey, setLastPreviewRefreshKey] = useState(() =>
    previewStateToolKey(stream?.messages ?? []),
  );

  // Pending runtime-error report captured from the iframe — picked up by
  // a downstream effect that auto-bubbles it to the agent once the chat
  // task is idle. We can't fire sendMessage straight from the message
  // listener because the listener registers once on mount and would
  // capture stale `stream`/`taskStatus` references. Routing through
  // useState lets a fresh effect re-run with live values. The `seq` field
  // (Date.now()) ensures identical errors after a turn boundary still
  // trigger the effect — without it, setState would no-op on a deep-equal
  // value and the second auto-bubble would never fire.
  const [pendingErrorReport, setPendingErrorReport] = useState<{
    prompt: string;
    key: string;
    seq: number;
  } | null>(null);
  // Track the last error signature we already auto-reported, kept in
  // useState (not a ref) so reading it during the effect doesn't trip
  // the ban-ref-current-assignment lint rule. State here is fine because
  // we *want* changes to retrigger evaluation when paired with the seq.
  const [lastAutoReportedKey, setLastAutoReportedKey] = useState<string | null>(
    null,
  );
  // Browser-as-REPL: ids of block-patch tool calls already dispatched to
  // the iframe. Prevents replaying the same patch on every render and on
  // stream reconnect (the chat-stream provider re-emits the full message
  // list, so without this set the iframe would receive 2× / 3× the same
  // host:render-block message).
  //
  // Keyed by taskId so positional fallback ids ("#0", "#1") from a prior
  // chat don't collide with the new chat's positions. toolCallId-based
  // ids would dedupe correctly even without this reset, but we can't
  // guarantee every stream message carries one.
  const [dispatchedBlockPatches, setDispatchedBlockPatches] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const [dispatchedTaskId, setDispatchedTaskId] = useState<string | null>(
    taskId ?? null,
  );
  if (taskId !== dispatchedTaskId) {
    // Render-phase reset is safe because the value is derived from props
    // (taskId) and only fires on transition. Replaces a useEffect dance
    // that would otherwise be one render late.
    setDispatchedTaskId(taskId ?? null);
    setDispatchedBlockPatches(new Set<string>());
  }

  const {
    data: status,
    isLoading,
    refetch,
  } = useQuery({
    // Keep the queryKey STABLE across refetches. If we bumped a nonce into
    // the key, every refetch would be a new cache entry and `status` would
    // briefly be `undefined` during the new fetch — that collapses
    // `pages = []`, makes `sessionPage = null`, makes `hasStreamSignal =
    // false`, and the intent falls through to the welcome screen until
    // the new fetch resolves. With a stable key, TanStack Query retains
    // the previous `data` during `refetch()` so the iframe never flashes
    // back to the welcome quiz mid-build.
    queryKey: KEYS.pagePreviewStatus(org.slug),
    queryFn: async () => {
      const response = await fetch(
        `/api/${encodeURIComponent(org.slug)}/page-preview/state`,
      );
      if (!response.ok) {
        throw new Error(`Failed to load page preview: ${response.status}`);
      }
      return (await response.json()) as PagePreviewStatus;
    },
    staleTime: 0,
    retry: false,
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — DOM event listener; cleanup runs on unmount
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const type = (data as { type?: unknown }).type;

      // Host handshake. Until we see this, intent-dispatch effects buffer
      // their messages (the host wouldn't have its listener installed yet).
      if (type === HOST_READY_MESSAGE_TYPE) {
        setHostReady(true);
        return;
      }

      // Welcome-quiz button posts a composed prompt to drop into the chat
      // input.
      if (type === PROMPT_MESSAGE_TYPE) {
        const text = (data as { text?: unknown }).text;
        if (typeof text !== "string" || !text.trim()) return;
        composeChatInput(text);
        return;
      }

      // Review-tip Accept button (and Accept-all) posts a composed prompt
      // that should fill the chat input AND submit immediately — the user
      // clicks once and the agent is already on it.
      if (type === PROMPT_AND_SEND_MESSAGE_TYPE) {
        const text = (data as { text?: unknown }).text;
        if (typeof text !== "string" || !text.trim()) return;
        composeAndSubmitChatInput(text);
        return;
      }

      // User picked a card from the host's design-system grid view.
      // Apply that DS to the current page (retheme), or open its demo
      // when no page is active. Then close the grid.
      if (type === HOST_SELECT_DS_MESSAGE_TYPE) {
        const slug = (data as { slug?: unknown }).slug;
        if (typeof slug === "string" && slug) {
          setThemeOverrideSlug(slug);
          setGridOpen(false);
        }
        return;
      }

      // User clicked Close in the host's design-system grid.
      if (type === HOST_CLOSE_DS_GRID_MESSAGE_TYPE) {
        setGridOpen(false);
        return;
      }

      // User clicked "Reload preview" on the host's error card. Force a
      // real iframe reload — and clear host-ready so the next dispatch
      // round happens only after the new host handshake.
      if (type === HOST_REQUEST_REFRESH_MESSAGE_TYPE) {
        setHostReady(false);
        lastDispatchRef.current = null;
        const f = iframeRef.current;
        if (f) {
          // Re-assign src to force a fresh load without remounting the
          // <iframe> element (so the React ref stays valid).
          // eslint-disable-next-line no-self-assign
          f.src = f.src;
        }
        return;
      }

      // Iframe runtime-error card. We capture into state and let a
      // downstream effect decide whether to auto-bubble to the agent
      // or fall back to composing into the chat input. Splitting it
      // this way keeps live `stream`/`taskStatus` reads out of the
      // message handler (which is registered once with stale refs).
      // The in-iframe error card stays mounted regardless — it's the
      // visual signal that something broke.
      if (type === RUNTIME_ERROR_MESSAGE_TYPE) {
        const payload = (data as { payload?: unknown }).payload as
          | {
              headline?: unknown;
              location?: unknown;
              message?: unknown;
            }
          | undefined;
        if (!payload) return;
        const location =
          typeof payload.location === "string" && payload.location
            ? payload.location
            : "the preview";
        const message =
          typeof payload.message === "string"
            ? payload.message.slice(0, 1200)
            : "(no message)";
        const headline =
          typeof payload.headline === "string" ? payload.headline : "Error";
        const prompt = [
          `The preview is showing a runtime error: **${headline}** at \`${location}\`.`,
          "",
          "```",
          message,
          "```",
          "",
          "Please open the file referenced above, find and fix the bug, then call PAGE_PREVIEW_REFRESH so the preview reloads. Use one Edit, then refresh.",
        ].join("\n");
        const errKey = `${headline}\n${location}\n${message.slice(0, 240)}`;
        setPendingErrorReport({ prompt, key: errKey, seq: Date.now() });
        return;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — reload when the agent calls preview-state tools
  useEffect(() => {
    const nextKey = previewStateToolKey(stream?.messages ?? []);
    if (nextKey === lastPreviewRefreshKey) return;
    setLastPreviewRefreshKey(nextKey);
    setForceWelcome(false);
    setOverride(null);
    setRefreshNonce((k) => k + 1);
    void refetch();
  }, [stream?.messages, lastPreviewRefreshKey, refetch]);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — reload preview once when a task run finishes
  useEffect(() => {
    if (lastTaskStatus === taskStatus) return;
    const wasRunning =
      lastTaskStatus === "in_progress" || lastTaskStatus === "expired";
    const isRunning = taskStatus === "in_progress" || taskStatus === "expired";
    setLastTaskStatus(taskStatus);
    if (wasRunning && !isRunning) {
      setForceWelcome(false);
      setOverride(null);
      setRefreshNonce((k) => k + 1);
      void refetch();
      // Agent's turn just finished — clear the auto-report dedupe so a
      // recurring error on the *next* refresh can re-bubble to the agent.
      // If the same error keeps firing, the agent keeps getting nudged
      // until it actually fixes the bug (or the user intervenes).
      setLastAutoReportedKey(null);
    }
  }, [lastTaskStatus, taskStatus, refetch]);

  // Auto-bubble runtime errors to the agent. Runs whenever a new
  // pendingErrorReport lands OR when the chat task transitions to
  // idle (in case an error arrived while the agent was busy and got
  // deferred). If we can fire, do it; otherwise compose the prompt
  // into the chat input as a manual fallback the user can send.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — coordinates async send with task-status transitions
  useEffect(() => {
    if (!pendingErrorReport) return;
    const liveStream = stream;
    // Mirror the in_progress / expired definition used elsewhere in this
    // file. While the agent is mid-turn we don't pile on another user
    // message — wait for it to finish, then this effect re-runs.
    const agentIdle =
      liveStream != null &&
      !liveStream.isStreaming &&
      taskStatus !== "in_progress" &&
      taskStatus !== "expired";
    if (!agentIdle) return;
    if (lastAutoReportedKey === pendingErrorReport.key) {
      // Already auto-reported this exact error — don't spam. Fall back
      // to composing into the input so the user can decide to escalate.
      composeChatInput(pendingErrorReport.prompt);
      setPendingErrorReport(null);
      return;
    }
    setLastAutoReportedKey(pendingErrorReport.key);
    const doc = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: pendingErrorReport.prompt }],
        },
      ],
    };
    void liveStream.sendMessage(doc);
    setPendingErrorReport(null);
  }, [pendingErrorReport, stream, taskStatus, lastAutoReportedKey]);

  const pages = status?.pages ?? [];
  const designSystems = status?.designSystems ?? [];
  const isTaskRunning =
    taskStatus === "in_progress" || taskStatus === "expired";
  // The live progress label drives an animated status overlay above the
  // iframe. Prefer the chat stream (instantaneous), fall back to the
  // server-side state (survives tab reopens) ONLY while a task is
  // actively running — otherwise a stale progressLabel from a previous
  // build's last step keeps floating over a brand new chat's welcome
  // screen ("Laying out the features grid…" on a fresh recruit).
  const streamProgress = deriveLiveProgress(
    stream?.messages ?? [],
    isTaskRunning,
  );
  const streamOutline = deriveLiveOutline(stream?.messages ?? []);
  const reviewTips = deriveReviewTips(stream?.messages ?? []);
  const canUseServerFallback = isTaskRunning && !stream?.messages?.length;
  const effectiveOutline =
    streamOutline ?? (canUseServerFallback ? (status?.outline ?? null) : null);
  const progressLabel =
    streamProgress ??
    (canUseServerFallback ? (status?.progressLabel ?? null) : null);
  // What did the agent build in THIS chat? The preview iframe should
  // only follow these — never an old slug the agent happens to
  // PAGE_PREVIEW_SET to during exploration.
  const sessionItems = deriveSessionItems(stream?.messages ?? []);

  // Dropdown click handlers — these mutate UI state only. They explicitly
  // do NOT bump refreshNonce / refetch, because:
  //
  //   - The dropdown items came from the already-loaded `status`, so a
  //     refetch wouldn't change the list.
  //   - Re-keying the useQuery briefly returns `undefined` for `status`
  //     while the new query fetches, which makes `pages = []`,
  //     `overridePage = pages.find(...) === undefined`, and the intent
  //     transitions through `welcome` before settling. The host sees
  //     host:welcome → host:set-page in quick succession and the user
  //     ends up staring at the welcome screen.
  //
  // The right model: dropdown clicks are pure local-state. Status only
  // refetches when the chat stream signals a meaningful change.
  const handleSelectPage = (page: PageEntry) => {
    setOverride({ kind: "page", slug: page.slug });
    setForceWelcome(false);
    setGridOpen(false);
    setThemeOverrideSlug(null);
    setPageMenuOpen(false);
  };

  // Design-system dropdown click: **retheme** the current page instead of
  // replacing it. When the host is on the welcome / grid view, this also
  // pulls the user back to a page view (or DS demo if no page).
  const handleSelectDesignSystem = (ds: DesignSystemEntry) => {
    setThemeOverrideSlug(ds.slug);
    setForceWelcome(false);
    setGridOpen(false);
    setDsMenuOpen(false);
  };

  const handleManageDesignSystems = () => {
    setGridOpen(true);
    setForceWelcome(false);
    setDsMenuOpen(false);
  };

  const handleNewPage = () => {
    setForceWelcome(true);
    setGridOpen(false);
    setPageMenuOpen(false);
    setDsMenuOpen(false);
  };

  // Determine what to render.
  const overridePage =
    override?.kind === "page"
      ? (pages.find((p) => p.slug === override.slug) ?? null)
      : null;
  const overrideDs =
    override?.kind === "design-system"
      ? (designSystems.find((d) => d.slug === override.slug) ?? null)
      : null;

  // What goes in the iframe? Priority:
  //   1. User override (dropdown click) — always wins.
  //   2. Session-page (created by PAGE_PREVIEW_PAGE_CREATE in this chat)
  //      once the agent has SET / REFRESHED it.
  //   3. Session design system (created by DESIGN_SYSTEM_CREATE in this
  //      chat). Default once the design system exists but the page isn't
  //      promoted yet.
  //   4. Nothing — show the welcome quiz.
  // We deliberately ignore status.activeKind / activePath when stream
  // data is present: state.json persists across chats and the agent's
  // PAGE_PREVIEW_SET to a stale slug should NOT yank an old page into
  // the preview.
  // Resolve session slugs against the loaded on-disk listings. A session
  // slug that isn't represented in `pages` / `designSystems` is treated as
  // non-existent and ignored — this handles the case where a tool call
  // referenced a slug that didn't actually land on disk (failed call,
  // typo, mid-stream output, manual cleanup, etc.). The dropdown's
  // available items are always real, so manual picks keep working.
  const sessionPage = sessionItems.pageSlug
    ? (pages.find((p) => p.slug === sessionItems.pageSlug) ?? null)
    : null;
  const sessionDs = sessionItems.designSystemSlug
    ? (designSystems.find((d) => d.slug === sessionItems.designSystemSlug) ??
      null)
    : null;

  // Only count as a stream signal if the slug resolves to a real on-disk
  // item. Otherwise we'd suppress the welcome fallback and try to load a
  // page/DS that doesn't exist.
  const hasStreamSignal = sessionPage !== null || sessionDs !== null;

  // Pre-compute whether any preview-state tool has fired in this stream
  // (PROGRESS counts). Used below to gate the server-state fallback so it
  // ONLY fires on true tab reloads (no stream activity yet) — not on a
  // brand-new chat where the agent has called PROGRESS but hasn't yet
  // created a DS / page. Without this gate the new chat falls back to the
  // PREVIOUS chat's active page, which is what the user sees on screen.
  const previewToolFiredEarly = hasAnyPreviewToolFired(stream?.messages ?? []);

  const activePage =
    overridePage ??
    (sessionPage && sessionItems.pageActivated ? sessionPage : null) ??
    // Server-side state fallback — ONLY for a true cold load:
    //   - nothing in this session's stream (no preview tool fired yet)
    //   - and no override
    // Covers tab reload AFTER a previous build completed. Does NOT cover
    // "new chat in flight" — the agent's first PROGRESS call exits this
    // fallback so we don't yank a stale page in.
    (!previewToolFiredEarly && !hasStreamSignal && status?.activeKind === "page"
      ? (pages.find((p) => p.relativePath === status?.activeRelativePath) ??
        null)
      : null);

  const showKind: PreviewKind | null = override
    ? override.kind
    : activePage
      ? "page"
      : sessionDs
        ? "design-system"
        : !previewToolFiredEarly &&
            !hasStreamSignal &&
            status?.activeKind === "design-system"
          ? "design-system"
          : null;

  // The design-system selector should always reflect *something*: when a
  // page is showing, it shows the design system that page is bound to;
  // when a design system is the live preview, it shows that one.
  const dsByPageBinding = activePage?.designSystem
    ? (designSystems.find((d) => d.slug === activePage.designSystem) ?? null)
    : null;
  const activeDs =
    overrideDs ??
    (showKind === "design-system" ? sessionDs : null) ??
    dsByPageBinding ??
    (showKind === "design-system" &&
    !hasStreamSignal &&
    status?.activeDesignSystem
      ? (designSystems.find((d) => d.slug === status.activeDesignSystem) ??
        null)
      : null);

  // "Build room" intermission. From submit until a *real page* exists,
  // the preview would otherwise bounce between the welcome quiz and a
  // bare design-system demo. Keep one stable shell alive instead:
  //   - before artifacts: rows + speculative sketch
  //   - once the DS exists: same shell, but the right rail becomes the
  //     actual design system
  //   - once a page is activated: hand off to the real page renderer
  //
  // This keeps early progress visible without pretending a page exists
  // before one actually does.
  const userPrompt = deriveLatestUserPrompt(
    (stream?.messages ?? []) as unknown as Array<Record<string, unknown>>,
  );
  const previewToolFired = hasAnyPreviewToolFired(stream?.messages ?? []);
  const isBuilding =
    isTaskRunning && !activePage && userPrompt !== null && !override;

  // A "fresh chat" is one where no preview-state tool has fired in the
  // current stream. We default to the welcome quiz in that case, even
  // when pages/design-systems already exist on disk from previous chats —
  // so opening a new conversation starts at "what do you want to build?"
  // not at the previous run's output. Clicking a page in the dropdown
  // (sets `override`) takes the user out of fresh-chat mode.
  //
  // NOTE: we gate on `hasAnyPreviewToolFired` (includes PAGE_PREVIEW_PROGRESS)
  // rather than `lastPreviewRefreshKey` (disk-mutating tools only) so the
  // first PROGRESS call breaks the welcome state even before any disk
  // write — otherwise the agent's reading/planning phase keeps the user
  // staring at the quiz.
  const isFreshChat = !previewToolFired && !override;

  // The effective design system for retheming: explicit override wins,
  // else the page's bound DS, else the session DS, else nothing.
  const effectiveDsSlug =
    themeOverrideSlug ?? activePage?.designSystem ?? activeDs?.slug ?? null;

  // What does the user want the host to show?
  // 'prelude' = the agent's turn has started but no page artifacts exist
  // yet. The iframe stays in page mode and shows the user's brief inside
  // a centered card while the stepper holds the top. As the DS / blocks
  // land, the same shell morphs through design-system → layout → building
  // → done without any crossfade.
  type Intent =
    | { kind: "welcome" }
    | { kind: "prelude"; prompt: string }
    | { kind: "page"; slug: string; dsSlug: string }
    | { kind: "ds-demo"; dsSlug: string }
    | { kind: "ds-grid" };

  let intent: Intent;
  if (gridOpen) {
    intent = { kind: "ds-grid" };
  } else if (forceWelcome) {
    intent = { kind: "welcome" };
  } else if (isBuilding) {
    intent = { kind: "prelude", prompt: userPrompt! };
  } else if (isFreshChat && !hasStreamSignal) {
    // Fresh chat (no preview-state tools fired, no user override) →
    // welcome quiz. This must come BEFORE the status-fallback page
    // branch — otherwise state.json from a previous chat's last
    // edited page would yank us straight into that page instead of
    // showing the quiz.
    intent = { kind: "welcome" };
  } else if (activePage && effectiveDsSlug) {
    intent = {
      kind: "page",
      slug: activePage.slug,
      dsSlug: effectiveDsSlug,
    };
  } else if (effectiveDsSlug) {
    intent = { kind: "ds-demo", dsSlug: effectiveDsSlug };
  } else {
    intent = { kind: "welcome" };
  }

  // Stable JSON key — every intent change triggers a postMessage cascade.
  const intentKey = JSON.stringify(intent);

  const pageLabel = activePage ? activePage.name : "no page";
  // The dropdown label shows the EFFECTIVE design system (theme override
  // first, then the binding) so the user sees what's currently applied.
  const dsLabelTarget =
    designSystems.find((d) => d.slug === effectiveDsSlug) ?? activeDs;
  const dsLabel = dsLabelTarget ? dsLabelTarget.name : "no design system";

  // Bridge: dispatch the right host message for the current intent.
  // Differentiates "the page stayed but the theme changed" from "the
  // page or mode actually changed" so a DS dropdown click triggers a
  // smooth retheme (CSS-variable transition only) instead of a full
  // crossfade + module reload.
  const lastDispatchRef = useRef<Intent | null>(null);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — message bus to iframe; needs host readiness gate
  useEffect(() => {
    if (!hostReady) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const prev = lastDispatchRef.current;
    lastDispatchRef.current = intent;

    // Page → page with same slug, only DS changed → retheme in place.
    if (
      prev &&
      prev.kind === "page" &&
      intent.kind === "page" &&
      prev.slug === intent.slug &&
      prev.dsSlug !== intent.dsSlug
    ) {
      win.postMessage({ type: "host:retheme", slug: intent.dsSlug }, "*");
      return;
    }
    // DS-demo → DS-demo (different slug) → retheme.
    if (
      prev &&
      prev.kind === "ds-demo" &&
      intent.kind === "ds-demo" &&
      prev.dsSlug !== intent.dsSlug
    ) {
      win.postMessage(
        { type: "host:show-design-system", slug: intent.dsSlug },
        "*",
      );
      return;
    }

    if (intent.kind === "welcome") {
      win.postMessage({ type: "host:welcome" }, "*");
    } else if (intent.kind === "prelude") {
      win.postMessage({ type: "host:prelude", prompt: intent.prompt }, "*");
    } else if (intent.kind === "page") {
      win.postMessage(
        {
          type: "host:set-page",
          slug: intent.slug,
          designSystem: intent.dsSlug,
        },
        "*",
      );
    } else if (intent.kind === "ds-demo") {
      win.postMessage(
        { type: "host:show-design-system", slug: intent.dsSlug },
        "*",
      );
    } else if (intent.kind === "ds-grid") {
      win.postMessage(
        {
          type: "host:show-design-system-grid",
          designSystems: designSystems.map((d) => ({
            slug: d.slug,
            name: d.name,
            brand: d.brand,
          })),
        },
        "*",
      );
    }
  }, [hostReady, intentKey]);

  // When the agent triggers a refresh AND we're already on a page intent,
  // tell the host to re-fetch its modules and re-render in-place (so only
  // new sections animate in).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — listens for chat-stream refresh signals
  useEffect(() => {
    if (!hostReady) return;
    if (intent.kind !== "page") return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "host:refresh-page" }, "*");
    // intentKey is intentionally not a dep — this fires on every
    // refreshNonce / refresh-tool event, even when intent stays the same.
  }, [hostReady, refreshNonce, intent.kind]);

  // Browser-as-REPL block-patch dispatch.
  //
  // Each successful PAGE_RENDER_BLOCK / UPDATE_BLOCK / REMOVE_BLOCK tool
  // call in the chat stream maps to a single postMessage to the iframe.
  // We keep a `dispatchedBlockPatches` state set of ids already dispatched,
  // so re-running the effect on subsequent stream updates only fires the
  // NEW calls (and never re-applies an already-applied patch). The ids
  // are stable across renders (toolCallId from the SDK, or a positional
  // fallback derived in deriveBlockPatchCalls).
  const blockPatchCalls = deriveBlockPatchCalls(stream?.messages ?? []);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — drives the in-iframe section patch loop
  useEffect(() => {
    if (!hostReady) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const fresh: BlockPatchCall[] = [];
    for (const call of blockPatchCalls) {
      if (dispatchedBlockPatches.has(call.id)) continue;
      fresh.push(call);
    }
    if (fresh.length === 0) return;
    // The iframe needs to load sections.js to render any block. Pass the
    // page slug + design-system slug along on every block message so it
    // can lazy-load on the first call if the legacy host:set-page flow
    // never fired (which it doesn't in the new REPL flow). We derive the
    // designSystem from the session items (latest DESIGN_SYSTEM_CREATE).
    const dsSlugForBlock = sessionItems.designSystemSlug ?? null;
    for (const call of fresh) {
      if (call.kind === "render") {
        win.postMessage(
          {
            type: "host:render-block",
            slug: call.slug,
            designSystem: dsSlugForBlock,
            section: call.section,
            props: call.props,
          },
          "*",
        );
      } else if (call.kind === "update") {
        win.postMessage(
          {
            type: "host:update-block",
            slug: call.slug,
            designSystem: dsSlugForBlock,
            index: call.index,
            props: call.props,
            replace: call.replace,
          },
          "*",
        );
      } else if (call.kind === "remove") {
        win.postMessage(
          {
            type: "host:remove-block",
            slug: call.slug,
            designSystem: dsSlugForBlock,
            index: call.index,
          },
          "*",
        );
      }
    }
    setDispatchedBlockPatches((prev) => {
      const next = new Set(prev);
      for (const call of fresh) next.add(call.id);
      return next;
    });
  }, [
    hostReady,
    blockPatchCalls,
    dispatchedBlockPatches,
    sessionItems.designSystemSlug,
  ]);

  // Keep the host's design-systems list (used by the grid view) in sync.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — keeps the host's local DS cache fresh
  useEffect(() => {
    if (!hostReady) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        type: "host:update-design-systems",
        designSystems: designSystems.map((d) => ({
          slug: d.slug,
          name: d.name,
          brand: d.brand,
        })),
      },
      "*",
    );
    // Send filesBase once we're ready so dynamic-import URLs resolve.
    win.postMessage({ type: "host:hello", filesBase }, "*");
  }, [hostReady, designSystems.length, filesBase]);

  // Pipe the live progress label, isRunning state, and agent-declared
  // outline to the host. The host renders the "drafting next…" slot and
  // the sticky stepper from these. We deliberately keep the Studio-side
  // floating ProgressOverlay (system chrome) AND the host-side inline
  // affordances (content chrome) — they serve different roles.
  const outlineKey = effectiveOutline ? effectiveOutline.join("|") : "";
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — bridge handshake
  useEffect(() => {
    if (!hostReady) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        type: "host:set-page-progress",
        label: progressLabel,
        isRunning: isTaskRunning,
        outline: effectiveOutline,
        buildState: {
          designSystem: sessionDs
            ? {
                slug: sessionDs.slug,
                name: sessionDs.name,
                brand: sessionDs.brand,
              }
            : null,
          pageCreated: sessionPage !== null,
          pageActivated: activePage !== null,
        },
      },
      "*",
    );
  }, [
    hostReady,
    progressLabel,
    isTaskRunning,
    outlineKey,
    sessionDs?.slug,
    sessionPage?.slug,
    activePage?.slug,
  ]);

  // Pipe review tips to the iframe so they render as floating tooltips on
  // matching sections. Keyed on the tips' ids — when a new
  // PAGE_REVIEW_SUGGEST lands in the stream the effect re-fires.
  const tipsKey = reviewTips.map((t) => t.id).join("|");
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — review-tip dispatch bridge
  useEffect(() => {
    if (!hostReady) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "host:set-review-tips", tips: reviewTips }, "*");
  }, [hostReady, tipsKey]);

  const handleExport = () => {
    if (!status) return;
    let target: { kind: "page" | "design-system"; slug: string } | null = null;
    if (intent.kind === "page") {
      target = { kind: "page", slug: intent.slug };
    } else if (intent.kind === "ds-demo") {
      target = { kind: "design-system", slug: intent.dsSlug };
    }
    if (!target) return;
    const url = `/api/${encodeURIComponent(org.slug)}/page-preview/export?kind=${encodeURIComponent(target.kind)}&slug=${encodeURIComponent(target.slug)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (isLoading && !status) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const exportDisabled =
    !status ||
    intent.kind === "welcome" ||
    intent.kind === "prelude" ||
    intent.kind === "ds-grid" ||
    (intent.kind === "page" && !activePage);

  return (
    <div className="h-full flex flex-col bg-muted/20">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border/50 text-xs text-muted-foreground bg-background/40">
        <div className="flex items-center gap-1 min-w-0">
          {/* Page selector */}
          <DropdownMenu open={pageMenuOpen} onOpenChange={setPageMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 min-w-0 px-2 py-1 rounded hover:bg-foreground/5 transition cursor-pointer focus:outline-none focus:ring-1 focus:ring-foreground/20",
                  intent.kind === "page"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
                title="Pages"
              >
                <FileCode01 size={12} className="shrink-0 opacity-70" />
                <span className="truncate font-mono">{pageLabel}</span>
                <ChevronDown size={12} className="shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuLabel className="text-xs">Pages</DropdownMenuLabel>
              {pages.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No pages yet. Ask the agent to build one.
                </div>
              ) : (
                pages.map((p) => {
                  const selected =
                    intent.kind === "page" && activePage?.slug === p.slug;
                  return (
                    <DropdownMenuItem
                      key={p.path}
                      onSelect={() => void handleSelectPage(p)}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Check
                          size={12}
                          className={cn(
                            "shrink-0",
                            selected ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="truncate font-mono text-xs">
                          {p.slug}
                        </span>
                        {p.designSystem && (
                          <span className="text-[10px] text-muted-foreground/70 font-mono">
                            · {p.designSystem}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] text-muted-foreground/70 shrink-0">
                        {formatRelative(p.lastModified)}
                      </span>
                    </DropdownMenuItem>
                  );
                })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleNewPage} className="gap-2">
                <Plus size={14} />
                New page
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-muted-foreground/40 px-0.5">·</span>

          {/* Design system selector */}
          <DropdownMenu open={dsMenuOpen} onOpenChange={setDsMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 min-w-0 px-2 py-1 rounded hover:bg-foreground/5 transition cursor-pointer focus:outline-none focus:ring-1 focus:ring-foreground/20",
                  intent.kind === "ds-demo" || intent.kind === "ds-grid"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
                title="Design systems — click to apply to the current page"
              >
                <Palette size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{dsLabel}</span>
                <ChevronDown size={12} className="shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuLabel className="text-xs">
                Design systems
              </DropdownMenuLabel>
              {designSystems.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">
                  No design systems yet. Ask the agent to create one.
                </div>
              ) : (
                designSystems.map((d) => {
                  const selected = effectiveDsSlug === d.slug;
                  return (
                    <DropdownMenuItem
                      key={d.slug}
                      onSelect={() => handleSelectDesignSystem(d)}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Check
                          size={12}
                          className={cn(
                            "shrink-0",
                            selected ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span
                          className="size-3 rounded-sm shrink-0 border border-border/40"
                          style={{ background: d.brand?.primary ?? "#888" }}
                        />
                        <span className="truncate text-xs">{d.name}</span>
                      </span>
                      <span className="text-[10px] text-muted-foreground/70 shrink-0">
                        {formatRelative(d.lastModified)}
                      </span>
                    </DropdownMenuItem>
                  );
                })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleManageDesignSystems}
                className="gap-2"
              >
                <Settings02 size={14} />
                Manage design systems
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {intent.kind === "welcome" && (
            <span className="text-muted-foreground/70 truncate ml-2">
              (welcome)
            </span>
          )}
          {intent.kind === "ds-grid" && (
            <span className="text-muted-foreground/70 truncate ml-2">
              (manage)
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={exportDisabled}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded transition cursor-pointer focus:outline-none focus:ring-1 focus:ring-foreground/20",
            exportDisabled
              ? "opacity-40 cursor-not-allowed"
              : "hover:bg-foreground/5",
          )}
          title="Download current item as .zip"
        >
          <Download01 size={12} className="shrink-0" />
          <span>Export</span>
        </button>
      </div>
      <div className="relative flex-1 min-h-0">
        {/*
          The host iframe is mounted ONCE per chat session. Re-keying it
          would tear down the host's preact tree, lose its ready state,
          and drop in-flight bridge messages — which broke "switch page in
          the dropdown" since handleSelectPage bumped refreshNonce. The
          host now stays mounted across every state change; explicit
          reloads happen via location.reload() inside the host (Reload
          preview button on the error card) and bubble back as
          page-editor:host-request-refresh, NOT via remount.
        */}
        <iframe
          ref={iframeRef}
          key="page-preview-host"
          title="Page preview"
          src={hostUrl}
          className="absolute inset-0 w-full h-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
        <ProgressOverlay
          // When the task is running but no progress label is set (the gap
          // between PROGRESS calls, e.g. while the agent does Read/Edit),
          // fall back to a generic "Working…" so the user can see the
          // agent is alive. Without this fallback the floating pill
          // disappears entirely and the DS demo looks frozen.
          label={progressLabel ?? (isTaskRunning ? "Working…" : null)}
          showSpinner={isTaskRunning}
          // When the host is in welcome / ds-grid mode there's no
          // live page underneath — show the full overlay. For page/demo
          // modes use the small floating pill so the user can see the
          // content take shape behind it.
          variant={
            intent.kind === "welcome" || intent.kind === "ds-grid"
              ? "full"
              : "floating"
          }
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Progress overlay
 *
 * Driven by PAGE_PREVIEW_PROGRESS tool calls in the chat stream. Renders an
 * animated card with a soft spinner and the agent's current step label.
 * Smoothly fades in when a new label arrives and fades out when a
 * scaffold/refresh tool clears it (the iframe content beneath then takes
 * over with its own staggered-reveal CSS).
 *
 *   variant="full"     — full-bleed dark glass card centered, used when the
 *                        iframe is the welcome quiz (no useful content
 *                        underneath).
 *   variant="floating" — small bottom-center pill over the live preview so
 *                        the user can see the page taking shape behind it.
 * ------------------------------------------------------------------------- */

function ProgressOverlay({
  label,
  showSpinner,
  variant,
}: {
  label: string | null;
  showSpinner: boolean;
  variant: "full" | "floating";
}) {
  // Track the displayed label separately so we can keep rendering it
  // during the fade-out animation after `label` becomes null.
  const [displayed, setDisplayed] = useState<string | null>(label);
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — drives crossfade timing for the label text
  useEffect(() => {
    if (label) {
      setDisplayed(label);
      return;
    }
    const id = setTimeout(() => setDisplayed(null), 320);
    return () => clearTimeout(id);
  }, [label]);

  const visible = !!label;
  if (!displayed && !visible) return null;

  if (variant === "full") {
    return (
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-300 ease-out",
          visible ? "opacity-100" : "opacity-0",
        )}
        aria-live="polite"
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 35%, rgba(10,10,15,0.78) 0%, rgba(10,10,15,0.55) 50%, rgba(10,10,15,0.0) 100%)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
          }}
        />
        <div className="relative flex items-center gap-3 px-5 py-3 rounded-full bg-black/55 border border-white/10 text-white shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
          {showSpinner && <Spinner />}
          <span
            key={displayed ?? ""}
            className="text-sm font-medium tracking-wide animate-in fade-in slide-in-from-bottom-1 duration-300"
          >
            {displayed}
          </span>
        </div>
      </div>
    );
  }

  // Floating pill at the bottom center.
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center transition-all duration-300 ease-out",
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
      )}
      aria-live="polite"
    >
      <div className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-black/72 border border-white/10 text-white shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur-md">
        {showSpinner && <Spinner small />}
        <span
          key={displayed ?? ""}
          className="text-[13px] font-medium tracking-wide animate-in fade-in slide-in-from-bottom-1 duration-300"
        >
          {displayed}
        </span>
      </div>
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? 12 : 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="animate-spin shrink-0 text-white"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
