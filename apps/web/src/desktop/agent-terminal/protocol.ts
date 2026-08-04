import type { HarnessId } from "@decocms/shared/harness/types";
import type { ThreadDisplayStatus } from "@/sdk";

// Output arrives in bounded PTY chunks; replay gaps are an empty reset marker
// followed by the retained chunks. Reject unexpectedly large control frames.
const MAX_SERVER_FRAME_BYTES = 256 * 1024;
const MAX_CLIENT_CONTROL_FRAME_BYTES = 256 * 1024;
const TERMINAL_INPUT_BYTES = 64 * 1024;
const BRACKETED_PASTE_OVERHEAD_BYTES = 13;
const MAX_PROMPT_BYTES = TERMINAL_INPUT_BYTES - BRACKETED_PASTE_OVERHEAD_BYTES;
// terminal-session accepts at most 64 KiB of raw input per write, while the
// local-api WebSocket accepts 256 KiB JSON messages. A 32 KiB raw chunk stays
// below both limits even when every byte needs JSON's longest escape sequence.
const MAX_INPUT_CHUNK_BYTES = 32 * 1024;

export type TerminalHarnessId = "claude-code" | "codex" | "opencode";
export type TerminalPhysicalState = "starting" | "running" | "exited";
export type TerminalLogicalState =
  | "idle"
  | "working"
  | "waiting_input"
  | "completed"
  | "failed"
  | "interrupted";

export interface TerminalDimensions {
  rows: number;
  cols: number;
}

export type TerminalClientFrame =
  | ({ type: "start"; harnessId: TerminalHarnessId } & TerminalDimensions & {
        initialPrompt?: string;
        requestId?: string;
      })
  | ({ type: "attach"; afterSeq?: number } & TerminalDimensions)
  | { type: "input"; data: string }
  | ({ type: "resize" } & TerminalDimensions)
  | { type: "interrupt" }
  | { type: "terminate" }
  | { type: "submit_prompt"; text: string; requestId: string };

export type TerminalServerFrame =
  | {
      type: "ready";
      sessionId?: string;
      generation: string;
      harnessId?: TerminalHarnessId;
      physicalState: TerminalPhysicalState;
      logicalState: TerminalLogicalState;
      lastSeq: number;
    }
  | {
      type: "output";
      seq: number;
      data: Uint8Array;
      replay: boolean;
    }
  | { type: "reset"; seq: number; data: Uint8Array }
  | {
      type: "state";
      physicalState: TerminalPhysicalState;
      logicalState: TerminalLogicalState;
      threadStatus?: ThreadDisplayStatus;
      harnessId?: TerminalHarnessId;
    }
  | { type: "prompt_accepted"; requestId: string }
  | {
      type: "exit";
      code?: number;
      signal?: string;
      expected: boolean;
    }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
      requestId?: string;
    };

export interface TerminalReplayFrame {
  kind: "output" | "reset";
  seq: number;
  data: Uint8Array;
  /** One mounted xterm may answer capability queries carried by this frame. */
  allowCapabilityReplies: boolean;
}

const PHYSICAL_STATES = new Set<TerminalPhysicalState>([
  "starting",
  "running",
  "exited",
]);
const LOGICAL_STATES = new Set<TerminalLogicalState>([
  "idle",
  "working",
  "waiting_input",
  "completed",
  "failed",
  "interrupted",
]);
const THREAD_STATUSES = new Set<ThreadDisplayStatus>([
  "in_progress",
  "requires_action",
  "failed",
  "completed",
  "expired",
]);

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeSequence(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function physicalState(value: unknown): TerminalPhysicalState | null {
  return typeof value === "string" &&
    PHYSICAL_STATES.has(value as TerminalPhysicalState)
    ? (value as TerminalPhysicalState)
    : null;
}

function logicalState(value: unknown): TerminalLogicalState | null {
  return typeof value === "string" &&
    LOGICAL_STATES.has(value as TerminalLogicalState)
    ? (value as TerminalLogicalState)
    : null;
}

export function toTerminalHarnessId(
  harnessId: unknown,
): TerminalHarnessId | null {
  if (harnessId === "claude-code") return "claude-code";
  if (harnessId === "codex") return "codex";
  if (harnessId === "opencode") return "opencode";
  return null;
}

export function fromTerminalHarnessId(
  harnessId: TerminalHarnessId | null | undefined,
): Extract<HarnessId, "claude-code" | "codex"> | "opencode" | null {
  if (harnessId === "claude-code") return "claude-code";
  if (harnessId === "codex") return "codex";
  if (harnessId === "opencode") return "opencode";
  return null;
}

export function threadStatusFromTerminalLifecycle(
  physicalState: TerminalPhysicalState,
  logicalState: TerminalLogicalState,
): Exclude<ThreadDisplayStatus, "expired"> {
  if (physicalState === "starting") return "in_progress";
  switch (logicalState) {
    case "working":
      return "in_progress";
    case "waiting_input":
      return "requires_action";
    case "idle":
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
      return "failed";
  }
}

export function terminalLifecycleAfterExit(
  frame: Extract<TerminalServerFrame, { type: "exit" }>,
  previousLogicalState: TerminalLogicalState | null,
): {
  logicalState: TerminalLogicalState;
  threadStatus: Exclude<ThreadDisplayStatus, "expired">;
} {
  if (frame.expected) {
    return { logicalState: "interrupted", threadStatus: "failed" };
  }

  // Mirrors local-api's durable mark_exited transition for the information
  // present on the wire. A CLI may exit normally without Studio requesting it.
  const failed =
    frame.code !== 0 ||
    previousLogicalState === "working" ||
    previousLogicalState === "waiting_input";
  return failed
    ? { logicalState: "failed", threadStatus: "failed" }
    : { logicalState: "completed", threadStatus: "completed" };
}

export function shouldResetTerminalReplay(
  previousSessionId: string | null,
  lastOutputSequence: number,
  ready: Extract<TerminalServerFrame, { type: "ready" }>,
): boolean {
  return (
    (previousSessionId !== null &&
      ready.sessionId !== undefined &&
      ready.sessionId !== previousSessionId) ||
    ready.lastSeq < lastOutputSequence
  );
}

function terminalHarnessId(value: unknown): TerminalHarnessId | undefined {
  return toTerminalHarnessId(value) ?? undefined;
}

function outputBytes(value: Record<string, unknown>): Uint8Array | null {
  const base64 = value.dataBase64;
  if (typeof base64 === "string") {
    try {
      const binary = atob(base64);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

/** Parse and validate the untrusted control frames received from local-api. */
export function parseTerminalServerFrame(
  raw: string,
): TerminalServerFrame | null {
  if (raw.length > MAX_SERVER_FRAME_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const value = record(parsed);
  if (!value || typeof value.type !== "string") return null;

  switch (value.type) {
    case "ready": {
      if (
        !hasOnlyKeys(value, [
          "type",
          "sessionId",
          "generation",
          "harnessId",
          "physicalState",
          "logicalState",
          "lastSeq",
        ])
      ) {
        return null;
      }
      const generation = value.generation;
      const physical = physicalState(value.physicalState);
      const logical = logicalState(value.logicalState);
      const lastSeq = safeSequence(value.lastSeq);
      if (
        typeof generation !== "string" ||
        generation.length === 0 ||
        !physical ||
        !logical ||
        lastSeq === null
      ) {
        return null;
      }
      const sessionId = value.sessionId;
      const harnessId = terminalHarnessId(value.harnessId);
      if (value.harnessId !== undefined && !harnessId) return null;
      return {
        type: "ready",
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        generation,
        ...(harnessId ? { harnessId } : {}),
        physicalState: physical,
        logicalState: logical,
        lastSeq,
      };
    }
    case "output": {
      if (!hasOnlyKeys(value, ["type", "seq", "dataBase64", "replay"])) {
        return null;
      }
      const seq = safeSequence(value.seq);
      const data = outputBytes(value);
      if (seq === null || !data) return null;
      return {
        type: "output",
        seq,
        data,
        replay: value.replay === true,
      };
    }
    case "reset": {
      if (!hasOnlyKeys(value, ["type", "seq", "dataBase64"])) return null;
      const seq = safeSequence(value.seq);
      const data = outputBytes(value);
      if (seq === null || !data) return null;
      return { type: "reset", seq, data };
    }
    case "state": {
      if (
        !hasOnlyKeys(value, [
          "type",
          "physicalState",
          "logicalState",
          "threadStatus",
          "harnessId",
        ])
      ) {
        return null;
      }
      const physical = physicalState(value.physicalState);
      const logical = logicalState(value.logicalState);
      if (!physical || !logical) return null;
      const rawThreadStatus = value.threadStatus;
      const threadStatus =
        typeof rawThreadStatus === "string" &&
        THREAD_STATUSES.has(rawThreadStatus as ThreadDisplayStatus)
          ? (rawThreadStatus as ThreadDisplayStatus)
          : undefined;
      const harnessId = terminalHarnessId(value.harnessId);
      if (value.harnessId !== undefined && !harnessId) return null;
      return {
        type: "state",
        physicalState: physical,
        logicalState: logical,
        ...(threadStatus ? { threadStatus } : {}),
        ...(harnessId ? { harnessId } : {}),
      };
    }
    case "prompt_accepted": {
      if (!hasOnlyKeys(value, ["type", "requestId"])) return null;
      const requestId = value.requestId;
      return typeof requestId === "string" && requestId
        ? { type: "prompt_accepted", requestId }
        : null;
    }
    case "exit": {
      if (!hasOnlyKeys(value, ["type", "code", "signal", "expected"])) {
        return null;
      }
      const code = value.code;
      const signal = value.signal;
      return {
        type: "exit",
        ...(typeof code === "number" && Number.isInteger(code) ? { code } : {}),
        ...(typeof signal === "string" ? { signal } : {}),
        expected: value.expected === true,
      };
    }
    case "error": {
      if (
        !hasOnlyKeys(value, [
          "type",
          "code",
          "message",
          "retryable",
          "requestId",
        ])
      ) {
        return null;
      }
      if (typeof value.code !== "string" || typeof value.message !== "string") {
        return null;
      }
      const requestId = value.requestId;
      return {
        type: "error",
        code: value.code,
        message: value.message,
        retryable: value.retryable === true,
        ...(typeof requestId === "string" && requestId ? { requestId } : {}),
      };
    }
    default:
      return null;
  }
}

export function normalizeTerminalDimensions(
  dimensions: TerminalDimensions,
): TerminalDimensions {
  return {
    rows: Math.min(500, Math.max(2, Math.floor(dimensions.rows))),
    cols: Math.min(1_000, Math.max(2, Math.floor(dimensions.cols))),
  };
}

/** Split an xterm input/paste into UTF-8-safe frames accepted by local-api. */
export function chunkTerminalInput(data: string): string[] {
  if (!data) return [];

  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let characters: string[] = [];
  let byteLength = 0;

  for (const character of data) {
    const characterBytes = encoder.encode(character).byteLength;
    if (
      characters.length > 0 &&
      byteLength + characterBytes > MAX_INPUT_CHUNK_BYTES
    ) {
      chunks.push(characters.join(""));
      characters = [];
      byteLength = 0;
    }
    characters.push(character);
    byteLength += characterBytes;
  }

  if (characters.length > 0) chunks.push(characters.join(""));
  return chunks;
}

/** Check both local-api's prompt limit and its serialized control-frame cap. */
export function terminalPromptFitsWire(
  text: string,
  requestId: string,
  harnessId: TerminalHarnessId,
): boolean {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength > MAX_PROMPT_BYTES) return false;

  // `start` has more envelope fields than `submit_prompt`, so fitting this
  // shape guarantees either terminal frame can carry the same prompt.
  const serialized = JSON.stringify({
    type: "start",
    harnessId,
    rows: 500,
    cols: 1_000,
    initialPrompt: text,
    requestId,
  } satisfies Extract<TerminalClientFrame, { type: "start" }>);
  return (
    encoder.encode(serialized).byteLength <= MAX_CLIENT_CONTROL_FRAME_BYTES
  );
}

export function terminalWebSocketUrl(
  location: Pick<Location, "host" | "protocol">,
  orgSlug: string,
  threadId: string,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/${encodeURIComponent(orgSlug)}/threads/${encodeURIComponent(threadId)}/terminal/ws`;
}

/**
 * Append an output frame to the renderer-side replay while bounding memory.
 * Reset frames replace the prior screen history; oversized single chunks keep
 * their tail because xterm can still render the most recent terminal state.
 */
export function appendTerminalReplay<Frame extends TerminalReplayFrame>(
  replay: readonly Frame[],
  frame: Frame,
  maxBytes: number,
): Frame[] {
  const next = frame.kind === "reset" ? [frame] : [...replay, frame];
  let size = next.reduce((total, item) => total + item.data.byteLength, 0);
  while (next.length > 1 && size > maxBytes) {
    size -= next[0]?.data.byteLength ?? 0;
    next.shift();
  }
  if (next.length === 1 && size > maxBytes) {
    const only = next[0]!;
    return [{ ...only, data: only.data.slice(-maxBytes) }];
  }
  return next;
}
