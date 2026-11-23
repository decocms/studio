/**
 * What a sandbox-hosted run's system-prompt append carries beyond the agent's
 * own instructions: the per-user context Decopilot renders into its system
 * prompt, as far as a person is in the run (`runAudience`), and the chat mode
 * the user picked for this message.
 * A chat also gets who its model is (`runIdentityParagraph`).
 */

import { getDecopilotId } from "@decocms/shared/sdk";
import type { ChatMode } from "@/harnesses/lib/decopilot/mode-config";
import { renderUserContextBlock } from "@/harnesses/lib/decopilot/user-context-block";
import type { HarnessUserContext } from "@/harnesses/lib/types";
import {
  type RunAudience,
  type RunThread,
  runAudience,
} from "@/harnesses/run-audience";

/** A Studio tool, named bare: the runner tells the model how a bare name is called (CLI or mounted server). */
export const studioTool = (name: string) => `the Studio tool \`${name}\``;

const MODE_TOOLS: Partial<Record<ChatMode, { label: string; tool: string }>> = {
  "gen-image": { label: "image generation", tool: "generate_image" },
  "web-search": { label: "web search", tool: "web_search" },
  "deep-research": { label: "deep research", tool: "deep_research" },
};

/** The line that turns a mode pill into a tool call, or null for other modes. */
export function modeInstruction(mode: ChatMode): string | null {
  const entry = MODE_TOOLS[mode];
  if (!entry) return null;
  return (
    `The user turned on ${entry.label} for this message: answer it by calling ` +
    `${studioTool(entry.tool)}.`
  );
}

const PREVIEW_INSTRUCTION =
  "The user watches your dev server in a live preview beside this chat. After you build or " +
  `change a page, call ${studioTool("preview_navigate")} with its path so they ` +
  "see it.";

export function sandboxRunPrompt(args: {
  mode: ChatMode;
  threadId: string;
  userEmail: string | undefined;
  userContext: HarnessUserContext;
  /** Who the run is for (`runAudience`): how much of "About this user" it gets. */
  audience: RunAudience;
  /** The user is watching this chat's dev-server preview. */
  previewWatched?: boolean;
}): string {
  return [
    args.audience === "unattended"
      ? null
      : renderUserContextBlock({
          user: { email: args.userEmail },
          currentThreadId: args.threadId,
          userContext: args.userContext,
          // History and interests are the thread opener's, not a teammate's.
          whoOnly: args.audience === "attended",
        }),
    modeInstruction(args.mode),
    args.previewWatched ? PREVIEW_INSTRUCTION : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Who the model is in a chat: a project's agent, or the organization's default one. */
export type RunIdentity =
  | {
      kind: "project";
      title: string;
      description?: string | null;
      organization?: string;
      /** Names of the project's connections this run may use. */
      connections: readonly string[];
      /** The run calls them through Studio, not as servers mounted on it. */
      connectionsViaStudio: boolean;
    }
  | {
      kind: "home";
      organization?: string;
      /** The run reaches the org connections its dispatcher may use. */
      reachesOrgConnections: boolean;
    };

const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_CONNECTION_NAME_CHARS = 40;
const MAX_CONNECTION_NAMES = 6;

/** User-written text as one quoted line that cannot close its own quotes or run long. */
function quoted(text: string, maxChars: number): string {
  const chars = Array.from(
    text
      .replace(/[\s\p{Cc}]+/gu, " ")
      .replaceAll('"', "'")
      .trim(),
  );
  const line =
    chars.length > maxChars
      ? `${chars
          .slice(0, maxChars - 1)
          .join("")
          .trimEnd()}…`
      : chars.join("");
  return `"${line}"`;
}

function nameList(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const shown = unique
    .slice(0, MAX_CONNECTION_NAMES)
    .map((name) => quoted(name, MAX_CONNECTION_NAME_CHARS));
  const more = unique.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length < 2) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

const connectionTools = (whose: "its" | "their") =>
  `find ${whose} tools with ${studioTool("CONNECTION_TOOLS_SEARCH")}, ` +
  `then call one with ${studioTool("CONNECTION_TOOL_CALL")}`;

/** The one paragraph that tells a chat's model who it is. Second person, no other agents, no tool lists. */
export function runIdentityParagraph(identity: RunIdentity): string {
  const organization = identity.organization?.trim()
    ? `the organization ${quoted(identity.organization, MAX_NAME_CHARS)}`
    : null;
  if (identity.kind === "home") {
    return [
      organization
        ? `You are the general assistant of ${organization}.`
        : "You are this organization's general assistant.",
      identity.reachesOrgConnections
        ? "You can reach the organization's connections that the person you " +
          `are talking to can use: ${connectionTools("their")}.`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const connections = nameList(identity.connections);
  return [
    `You are the agent of the project ${quoted(identity.title, MAX_NAME_CHARS)}` +
      `${organization ? ` in ${organization}` : ""}.`,
    identity.description?.trim()
      ? `The project's description: ${quoted(identity.description, MAX_DESCRIPTION_CHARS)}`
      : null,
    connections ? `It is connected to ${connections}.` : null,
    connections && identity.connectionsViaStudio
      ? `To use a connection, ${connectionTools("its")}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Who a run's model is told it is, or null for a run that gets no identity
 * paragraph: board, reviewer, Jira, triggered and automation runs carry a
 * persona prompt of their own. Reads only what the dispatch already loaded.
 */
export function resolveRunIdentity(args: {
  organization: { id: string; name?: string; slug?: string };
  agentId: string;
  /** The agent's row; null when it could not be read. */
  agent: { title?: string | null; description?: string | null } | null;
  /** `runMetadata.runClass`: set by the board and by triggered runs. */
  runClass: string | undefined;
  thread: RunThread | null | undefined;
  /** The member the run acts as. */
  userId: string;
  /** The run was given the org's connections as an interactive home chat. */
  homeChat: boolean;
  /** The connections on the run's key. */
  connections: readonly { id: string; title: string }[];
  /** Connections aggregated on the agent itself. */
  ownIds: ReadonlySet<string>;
  /** Connections mounted as servers of their own, whose tools the model already sees. */
  mountedIds: ReadonlySet<string>;
  /** The Studio tools the run's key carries. */
  selfTools: readonly string[];
}): RunIdentity | null {
  if (runAudience(args) === "unattended") return null;
  const organization = args.organization.name ?? args.organization.slug;
  const viaStudio = (connections: readonly { id: string }[]) =>
    args.selfTools.includes("CONNECTION_TOOLS_SEARCH") &&
    args.selfTools.includes("CONNECTION_TOOL_CALL") &&
    connections.some((connection) => !args.mountedIds.has(connection.id));
  if (args.agentId === getDecopilotId(args.organization.id)) {
    return {
      kind: "home",
      organization,
      reachesOrgConnections: args.homeChat && viaStudio(args.connections),
    };
  }
  const title = args.agent?.title?.trim();
  if (!title) return null;
  const own = args.connections.filter((connection) =>
    args.ownIds.has(connection.id),
  );
  return {
    kind: "project",
    title,
    description: args.agent?.description,
    organization,
    connections: own.map((connection) => connection.title),
    connectionsViaStudio: viaStudio(own),
  };
}
