import { nanoid } from "nanoid";

/** Message ID generator. Use as a closure where a `() => string` is
 *  expected (e.g. toUIMessageStreamResponse). Portable harness leaf — does
 *  not reach the cluster `@/shared/utils/generate-id`. */
export const generateMessageId = () => `msg_${nanoid()}`;

export const DEFAULT_MAX_TOKENS = 32768;
