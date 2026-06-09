/**
 * Cluster-side CONSUME half of a run, fed by a chunk stream produced elsewhere
 * (the desktop daemon, pushed over the link ingest). Mirrors the
 * `createUIMessageStream` + onStepFinish/onFinish/onError wiring in
 * `dispatch-run.ts`, minus the harness `execute` and the decopilot in-process
 * extras. Assembles chunks into messages, drives the emitter, and returns both
 * the assembled `uiStream` (for the caller to pump into the JetStream live
 * edge) and a `whenComplete` promise the caller awaits to know all durable
 * parts have been committed — instead of inferring completion from drain timing
 * (which is unsound on the error path, since the SDK invokes `onError`
 * synchronously, outside the stream's flush).
 */
import type { UIMessageChunk } from "ai";
import {
  consumeHarnessStream,
  type HarnessStreamTitleOptions,
} from "./consume-harness-stream";

/**
 * The slice of `PartEmitter` this consumer needs (so it stays unit-testable).
 * Method params mirror `PartEmitter`'s message shape exactly (`role` included)
 * so the real `PartEmitter` structurally satisfies this and an AI-SDK
 * `responseMessage` is assignable.
 */
export interface PartEmitterLike {
  emitStepParts(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
  }): Promise<void>;
  emitFinal(message: {
    id: string;
    role: "user" | "assistant" | "system";
    parts?: unknown[];
  }): Promise<void>;
  emitError(messageId: string, errorText: string): Promise<void>;
}

export interface ConsumePartStreamHooks {
  onStep?: () => void;
  onFinish?: () => void;
  onError?: (error: unknown) => void;
  title?: HarnessStreamTitleOptions;
}

export interface ConsumePartStreamResult {
  /**
   * The assembled UI message stream. The caller MUST consume it (pump/drain)
   * for the run to make progress and for `whenComplete` to resolve.
   */
  uiStream: ReadableStream;
  /**
   * Resolves after the terminal durable emit has settled — `emitFinal` on
   * success, or `emitError` on failure. The caller awaits this to know all
   * parts are committed, rather than inferring completion from drain timing.
   */
  whenComplete: Promise<void>;
}

const inertTitle: HarnessStreamTitleOptions = {
  currentThreadTitle: null,
  threadId: "",
  persistTitle: async () => {},
};

export function consumePartStream(
  chunks: AsyncIterable<UIMessageChunk>,
  emitter: PartEmitterLike,
  hooks: ConsumePartStreamHooks = {},
): ConsumePartStreamResult {
  const { uiStream, whenComplete } = consumeHarnessStream({
    chunks,
    originalMessages: [],
    title: hooks.title ?? inertTitle,
    persistence: emitter,
    hooks: {
      onStep: () => hooks.onStep?.(),
      onFinish: () => hooks.onFinish?.(),
      onError: hooks.onError,
    },
  });

  return { uiStream, whenComplete };
}
