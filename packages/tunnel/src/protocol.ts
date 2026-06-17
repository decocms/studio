import { z } from "zod";

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/u);
const headersSchema = z.array(z.tuple([z.string(), z.string()]));
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const subjectSchema = z.string().min(1);

export const requestStartFrameSchema = z.object({
  type: z.literal("request.start"),
  protocol: z.literal("tunnel.v1"),
  requestId: requestIdSchema,
  method: z.string().min(1),
  url: z.string().min(1),
  headers: headersSchema,
  replySubject: subjectSchema,
  bodySubject: subjectSchema.optional(),
  abortSubject: subjectSchema,
  deadlineUnixMs: z.number().int().nonnegative().optional(),
});

const requestChunkFrameSchema = z.object({
  type: z.literal("request.chunk"),
  requestId: requestIdSchema,
  seq: z.number().int().nonnegative(),
  data: base64UrlSchema,
});

const requestEndFrameSchema = z.object({
  type: z.literal("request.end"),
  requestId: requestIdSchema,
  seq: z.number().int().nonnegative(),
});

const requestErrorFrameSchema = z.object({
  type: z.literal("request.error"),
  requestId: requestIdSchema,
  code: z.string().min(1),
  message: z.string(),
});

export const requestBodyFrameSchema = z.union([
  requestChunkFrameSchema,
  requestEndFrameSchema,
  requestErrorFrameSchema,
]);

const responseAckFrameSchema = z.object({
  type: z.literal("response.ack"),
  requestId: requestIdSchema,
});

export const responseStartFrameSchema = z.object({
  type: z.literal("response.start"),
  requestId: requestIdSchema,
  status: z.number().int().min(100).max(599),
  statusText: z.string().optional(),
  headers: headersSchema,
});

const responseChunkFrameSchema = z.object({
  type: z.literal("response.chunk"),
  requestId: requestIdSchema,
  seq: z.number().int().nonnegative(),
  data: base64UrlSchema,
});

const responseEndFrameSchema = z.object({
  type: z.literal("response.end"),
  requestId: requestIdSchema,
  seq: z.number().int().nonnegative(),
});

const responseErrorFrameSchema = z.object({
  type: z.literal("response.error"),
  requestId: requestIdSchema,
  code: z.string().min(1),
  message: z.string(),
});

export const responseFrameSchema = z.union([
  responseAckFrameSchema,
  responseStartFrameSchema,
  responseChunkFrameSchema,
  responseEndFrameSchema,
  responseErrorFrameSchema,
]);

export const abortFrameSchema = z.object({
  type: z.literal("abort"),
  requestId: requestIdSchema,
  reason: z.string().optional(),
});

export const tunnelFrameSchema = z.union([
  requestStartFrameSchema,
  requestBodyFrameSchema,
  responseFrameSchema,
  abortFrameSchema,
]);

export type RequestStartFrame = z.infer<typeof requestStartFrameSchema>;
export type RequestBodyFrame = z.infer<typeof requestBodyFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type AbortFrame = z.infer<typeof abortFrameSchema>;
export type TunnelFrame = z.infer<typeof tunnelFrameSchema>;

export interface TunnelDiagnosticEvent {
  readonly event: string;
  readonly requestId?: string;
  readonly subject?: string;
  readonly elapsedMs?: number;
  readonly error?: string;
}

const schemaByFrameType = {
  "request.start": requestStartFrameSchema,
  "request.chunk": requestChunkFrameSchema,
  "request.end": requestEndFrameSchema,
  "request.error": requestErrorFrameSchema,
  "response.ack": responseAckFrameSchema,
  "response.start": responseStartFrameSchema,
  "response.chunk": responseChunkFrameSchema,
  "response.end": responseEndFrameSchema,
  "response.error": responseErrorFrameSchema,
  abort: abortFrameSchema,
} satisfies Record<string, z.ZodType<TunnelFrame>>;

type FrameType = keyof typeof schemaByFrameType;

const formatSchemaError = (error: z.ZodError): string => {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "frame";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
};

export const encodeTunnelFrame = (frame: TunnelFrame): Uint8Array => {
  return new TextEncoder().encode(JSON.stringify(frame));
};

export const decodeTunnelFrame = (bytes: Uint8Array): TunnelFrame => {
  let frame: unknown;
  try {
    frame = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new TypeError("malformed JSON in tunnel frame", { cause: error });
  }

  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    throw new TypeError("frame must be an object");
  }

  if (!("type" in frame)) {
    throw new TypeError("frame type missing");
  }

  const frameType = frame.type;
  const schema =
    typeof frameType === "string"
      ? schemaByFrameType[frameType as FrameType]
      : undefined;
  if (!schema) {
    throw new TypeError(`unknown frame type: ${String(frameType)}`);
  }

  const result = schema.safeParse(frame);
  if (!result.success) {
    throw new TypeError(
      `invalid tunnel frame: ${formatSchemaError(result.error)}`,
    );
  }

  return result.data;
};
